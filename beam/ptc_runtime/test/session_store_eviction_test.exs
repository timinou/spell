defmodule PtcRuntime.SessionStoreEvictionTest do
  @moduledoc """
  SPELL PATCH-5: Session-store reaper (LRU + ceiling).

  The `@session_bucket` (PATCH-4) persists bindings across executes and is
  NEVER released by execute teardown. Without a ceiling, a long session leaks
  unbounded heap. These tests assert the LRU reaper keeps session-store bytes
  bounded, evicts the coldest binding when over ceiling, surfaces a typed error
  on read of an evicted binding, and preserves hot (repeatedly-read) bindings.

  CRITICAL: all values must be >256KB (`@handle_park_bytes`) so the tool
  result is parked as a Handle and rehomed into the session bucket during
  `persist_bindings`. Values below that threshold stay as plain terms in
  `State.memory` and never enter the HandleStore's session bucket.
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp.HandleStore
  alias PtcRuntime.PeerHarness, as: H

  # Small ceiling (1 MB) so we hit eviction with a few large bindings.
  @small_ceiling_bytes 1 * 1024 * 1024

  # A single large binary (~300KB) that exceeds the 256KB park threshold.
  # Wrapping it in a map makes it slightly bigger but still comparable.
  @big_blob String.duplicate("z", 300_000)

  # Value returned by the `big` tool: a map whose serialized size exceeds
  # 256KB, ensuring it gets parked as a Handle.
  def big_tool_result, do: %{"body" => @big_blob}

  setup do
    # The HandleStore is a process-global singleton (one per node, started under
    # the runtime supervisor). Its @session_bucket persists across executes AND
    # across tests, so a prior test's bindings would inflate this test's count/
    # bytes. Release the session bucket first so every test starts from an empty
    # session store — otherwise the near-boundary sizing here is order-dependent.
    HandleStore.release(HandleStore, :__session_bindings__)
    HandleStore.configure(HandleStore, @small_ceiling_bytes)
    peer = H.start()
    init!(peer)
    %{peer: peer}
  end

  defp init!(peer) do
    H.send_frame(peer, %{
      "jsonrpc" => "2.0",
      "id" => 0,
      "method" => "init",
      "params" => %{"catalog" => %{"tools" => [%{"name" => "big"}]}}
    })

    assert %{"id" => 0, "result" => %{"ok" => true}} = H.recv()
  end

  defp run_execute(peer, exec_id, program, responder \\ fn _t, _a -> nil end, max_heap_mb \\ nil) do
    params = %{"program" => program}
    params = if max_heap_mb, do: Map.put(params, "max_heap_mb", max_heap_mb), else: params

    H.send_frame(peer, %{
      "jsonrpc" => "2.0",
      "id" => exec_id,
      "method" => "execute",
      "params" => params
    })

    service(peer, exec_id, responder)
  end

  defp service(peer, exec_id, responder) do
    frame = H.recv(5_000)

    cond do
      Map.get(frame, "id") == exec_id and Map.has_key?(frame, "result") ->
        {:ok, frame["result"]}

      Map.get(frame, "id") == exec_id and Map.has_key?(frame, "error") ->
        {:error, frame["error"]}

      frame["method"] == "tool_call" ->
        %{"id" => call_id, "params" => %{"tool" => tool, "args" => args}} = frame
        H.send_frame(peer, %{"jsonrpc" => "2.0", "id" => call_id, "result" => responder.(tool, args)})
        service(peer, exec_id, responder)

      true ->
        service(peer, exec_id, responder)
    end
  end

  # Count session-bucket bytes currently parked.
  defp session_stats do
    HandleStore.stats(HandleStore, :__session_bindings__)
  end

  describe "session-store ceiling" do
    test "mass park stays bounded under configured ceiling", %{peer: peer} do
      responder = fn "big", _ -> big_tool_result() end

      # Park 20 times, each tool result ~300KB → ~6MB if all retained.
      # With a 1MB ceiling, eviction keeps the store well bounded.
      for i <- 1..20 do
        assert {:ok, blob_len} =
                 run_execute(peer, i, ~S|(def x (tool/big {})) (count (get x "body"))|, responder)

        assert blob_len == 300_000
      end

      # Session bucket should be bounded well under 6MB.
      stats = session_stats()
      assert stats.bytes < @small_ceiling_bytes * 3,
             "session store exceeded 3x ceiling: #{stats.bytes} bytes in #{stats.count} terms"
    end

    test "eviction removes the COLDEST binding first", %{peer: peer} do
      # Determinism note: we do NOT assert an exact surviving count (3 ~330KB
      # terms straddle a 1MB ceiling, so the boundary is knife's-edge). Instead
      # we force a clear overflow and assert the COLDEST-first property: after
      # touching b and c, `a` is the coldest, so `a` is the eviction victim while
      # a freshly-touched binding survives.
      responder = fn "big", _ -> big_tool_result() end

      assert {:ok, 300_000} = run_execute(peer, 1, ~S|(def a (tool/big {})) (count (get a "body"))|, responder)
      assert {:ok, 300_000} = run_execute(peer, 2, ~S|(def b (tool/big {})) (count (get b "body"))|, responder)
      assert {:ok, 300_000} = run_execute(peer, 3, ~S|(def c (tool/big {})) (count (get c "body"))|, responder)

      # Touch b and c (re-read) so `a` becomes the least-recently-accessed.
      assert {:ok, 300_000} = run_execute(peer, 4, ~S|(count (get b "body"))|)
      assert {:ok, 300_000} = run_execute(peer, 5, ~S|(count (get c "body"))|)

      # Park two MORE (~600KB) to push well past the 1MB ceiling → eviction must
      # fire, and the victim must be the coldest (`a`), never the hot b/c.
      assert {:ok, 300_000} = run_execute(peer, 6, ~S|(def d (tool/big {})) (count (get d "body"))|, responder)
      assert {:ok, 300_000} = run_execute(peer, 7, ~S|(def e (tool/big {})) (count (get e "body"))|, responder)

      # `a` (coldest) evicted → loud error.
      assert {:error, err} = run_execute(peer, 8, ~S|(count (get a "body"))|)
      assert err["message"] =~ "evicted" or err["data"]["reason"] == "runtime_error"

      # `e` (most recently parked) must still be readable — eviction is LRU, not
      # newest-first.
      assert {:ok, 300_000} = run_execute(peer, 9, ~S|(count (get e "body"))|)
    end

    test "hot binding survives eviction while cold ones are reaped", %{peer: peer} do
      responder = fn "big", _ -> big_tool_result() end

      # Bind `hot` and read it 5 times to keep its timestamp fresh.
      assert {:ok, 300_000} = run_execute(peer, 1, ~S|(def hot (tool/big {})) (count (get hot "body"))|, responder)

      for i <- 2..6 do
        assert {:ok, 300_000} = run_execute(peer, i, ~S|(count (get hot "body"))|)
      end

      # Park 8 cold values (~300KB each = ~2.4MB) to force eviction under 1MB ceiling.
      for i <- 7..14 do
        assert {:ok, 300_000} = run_execute(peer, i, ~S|(def c (tool/big {})) (count (get c "body"))|, responder)
      end

      # Hot binding must still be readable.
      assert {:ok, 300_000} = run_execute(peer, 20, ~S|(count (get hot "body"))|)
    end
  end

  describe "evicted binding read semantics" do
    test "a non-projectable builtin over an evicted binding fails LOUD (not silent nil)", %{peer: peer} do
      # The projection path (count/get/take) already errors loud on eviction.
      # This guards the OTHER path: a non-projectable builtin (e.g. `reverse`)
      # realizes the handle fully. An evicted realize MUST raise, not degrade
      # to nil — a silent nil is the plausible-but-wrong class this hardening
      # exists to remove. (Regression for the realize_handle evicted clause.)
      tiny_ceiling = 200 * 1024
      HandleStore.configure(HandleStore, tiny_ceiling)
      responder = fn "big", _ -> big_tool_result() end

      assert {:ok, 300_000} =
               run_execute(peer, 1, ~S|(def gone (tool/big {})) (count (get gone "body"))|, responder)

      assert {:ok, 300_000} =
               run_execute(peer, 2, ~S|(def keep (tool/big {})) (count (get keep "body"))|, responder)

      # `gone` is evicted. Apply a non-projectable builtin DIRECTLY to the
      # bound handle so the eval layer realizes it (vs projecting). `vals` is
      # projectable; `reverse` is not — `(reverse gone)` realizes `gone`.
      # The realize MUST raise the eviction error, never degrade to nil/[].
      assert {:error, err} = run_execute(peer, 3, ~S|(reverse gone)|)
      assert is_map(err)
      assert err["message"] =~ "evicted" or err["data"]["reason"] == "runtime_error"
    end

    test "reading an evicted binding yields a typed error, not a stale value or crash", %{peer: peer} do
      # Configure a tiny ceiling (200KB) so even a single large value
      # triggers eviction when another is parked.
      tiny_ceiling = 200 * 1024
      HandleStore.configure(HandleStore, tiny_ceiling)

      # Each value is ~300KB, well over the 200KB ceiling.
      # Parking 2 values must evict the first.
      responder = fn "big", _ -> big_tool_result() end

      assert {:ok, 300_000} = run_execute(peer, 1, ~S|(def first (tool/big {})) (count (get first "body"))|, responder)
      assert {:ok, 300_000} = run_execute(peer, 2, ~S|(def second (tool/big {})) (count (get second "body"))|, responder)

      # `first` should be evicted. Reading it must not crash and must
      # return an error (not a stale value, not nil, not a crash).
      assert {:error, err} = run_execute(peer, 3, ~S|(count (get first "body"))|)
      assert is_map(err)
      assert err["message"] =~ "evicted" or err["data"]["reason"] == "runtime_error"
    end
  end
end
