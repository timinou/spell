defmodule PtcRuntime.SessionBindingsTest do
  @moduledoc """
  SPELL PATCH-4 (D-6): session bindings.

  `(def x v)` in one execute persists `v` for the next execute on the same
  Peer, reusing ptc_runner's def→memory machinery. Pins: cross-execute reuse,
  that a failed program does not commit bindings, and the critical
  handle-realization (a bound large tool result survives even though its store
  bucket is released at the defining execute's teardown).
  """
  use ExUnit.Case, async: false

  alias PtcRuntime.PeerHarness, as: H

  setup do
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

  describe "cross-execute bindings" do
    test "a def in one execute is visible in the next", %{peer: peer} do
      # `(def x v) x` ends in a value so the wire result encodes; the binding
      # is captured regardless (a bare `(def x v)` also binds, but returns a
      # non-encodable Var to the wire).
      assert {:ok, 42} = run_execute(peer, 1, ~S|(def answer 42) answer|)
      assert {:ok, 84} = run_execute(peer, 2, ~S|(* answer 2)|)
    end

    test "bindings accumulate across several executes", %{peer: peer} do
      assert {:ok, 10} = run_execute(peer, 1, ~S|(def a 10) a|)
      assert {:ok, 20} = run_execute(peer, 2, ~S|(def b 20) b|)
      assert {:ok, 30} = run_execute(peer, 3, ~S|(+ a b)|)
    end

    test "a later def shadows an earlier one", %{peer: peer} do
      assert {:ok, 1} = run_execute(peer, 1, ~S|(def x 1) x|)
      assert {:ok, 99} = run_execute(peer, 2, ~S|(def x 99) x|)
      assert {:ok, 99} = run_execute(peer, 3, ~S|x|)
    end

    test "a bare (def x v) still binds even though its wire return is the Var", %{peer: peer} do
      # Canonical REPL idiom: the wire return is the non-encodable Var (#'x),
      # so the wire result is an unencodable error — but the binding persists.
      assert {:error, err} = run_execute(peer, 1, ~S|(def k 7)|)
      assert err["data"]["reason"] == "unencodable_return"
      assert {:ok, 7} = run_execute(peer, 2, ~S|k|)
    end
  end

  describe "binding hygiene" do
    test "a failed program does not commit its defs", %{peer: peer} do
      # This program defs `leaked` then fails; the binding must NOT persist.
      assert {:error, _} = run_execute(peer, 1, ~S|(do (def leaked 7) (fail "boom"))|)
      # `leaked` is undefined in the next execute (preflight unbound-var error).
      assert {:error, err} = run_execute(peer, 2, ~S|leaked|)
      assert err["data"]["reason"] == "unbound_var"
    end

    test "an unbound var is still an error when no binding exists", %{peer: peer} do
      assert {:error, err} = run_execute(peer, 1, ~S|nonexistent|)
      assert err["data"]["reason"] == "unbound_var"
    end
  end

  describe "binding capture is a merge, not a replace" do
    test "a binding survives even when a later execute commits a different name", %{peer: peer} do
      # Simulates the concurrency hazard sequentially: bind x, then bind y in a
      # separate execute. A wholesale replace would drop x; a merge keeps both.
      assert {:ok, 1} = run_execute(peer, 1, ~S|(def x 1) x|)
      assert {:ok, 2} = run_execute(peer, 2, ~S|(def y 2) y|)
      assert {:ok, 3} = run_execute(peer, 3, ~S|(+ x y)|)
    end
  end

  describe "large computed (non-tool) binding does not poison later compiles" do
    test "a def'd multi-MB in-program list is parked, next execute still compiles", %{peer: peer} do
      # `(range 0 200000)` builds a large list in-program (no tool, so the
      # offload path never saw it). If seeded verbatim it would OOM the next
      # execute's smaller bounded compile heap. Parking keeps the binding a
      # small handle, so subsequent executes compile fine.
      assert {:ok, 200_000} = run_execute(peer, 1, ~S|(def nums (range 0 200000)) (count nums)|)
      # The very next execute must compile + run normally (not compile-OOM).
      assert {:ok, 3} = run_execute(peer, 2, ~S|(+ 1 2)|)
      # And the bound list is still projectable.
      assert {:ok, 200_000} = run_execute(peer, 3, ~S|(count nums)|)
    end
  end

  describe "bound large value survives via realization (handle interaction)" do
    test "a def'd large tool result is reusable next execute despite GC", %{peer: peer} do
      # The tool result is parked as a handle and bound. At THIS execute's
      # teardown the store bucket is released — but the binding was realized
      # first, so the next execute sees the full value, not a stale handle.
      big = %{"items" => for(i <- 1..400, do: %{"id" => i, "body" => String.duplicate("z", 2_000)})}
      responder = fn "big", _ -> big end

      assert {:ok, 400} =
               run_execute(peer, 1, ~S|(def dash (tool/big {})) (count (get dash "items"))|, responder)

      # Next execute: `dash` resolves to the realized value (no tool re-call),
      # and projecting it still works.
      assert {:ok, 400} = run_execute(peer, 2, ~S|(count (get dash "items"))|)
    end
  end
end
