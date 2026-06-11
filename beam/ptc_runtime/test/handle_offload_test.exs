defmodule PtcRuntime.HandleOffloadTest do
  @moduledoc """
  SPELL PATCH-3 (D-2): end-to-end proof that a large tool result is offloaded to
  the HandleStore and projected WITHOUT landing on the sandbox heap.

  This is the BUG-426 / E1 OOM scenario: `(tool/org {:command "dashboard"})`
  returns a payload far larger than the sandbox heap cap; the program only wants
  a count / a few fields. Before PATCH-3 the result copied onto the worker heap
  at reply and OOM'd before any projection ran. After PATCH-3 it's parked and
  the projection runs in the store.
  """
  use ExUnit.Case, async: false

  alias PtcRuntime.PeerHarness, as: H

  setup do
    # The supervised singleton HandleStore is already running (started by the
    # application). Each test uses a fresh exec id via the peer's own counter.
    peer = H.start(self(), worker_max_heap: 200_000)
    init!(peer)
    %{peer: peer}
  end

  defp init!(peer) do
    H.send_frame(peer, %{
      "jsonrpc" => "2.0",
      "id" => 0,
      "method" => "init",
      "params" => %{"catalog" => %{"tools" => [%{"name" => "big"}, %{"name" => "small"}]}}
    })

    assert %{"id" => 0, "result" => %{"ok" => true}} = H.recv()
  end

  # A payload that is large when serialized: 400 items each carrying a 2KB
  # "body" string → ~800KB external_size, well over the 256KB park threshold
  # and over the tight sandbox heap below.
  defp big_payload do
    items =
      for i <- 1..400 do
        %{"id" => "ITEM-#{i}", "title" => "t#{i}", "body" => String.duplicate("x", 2_000)}
      end

    %{"items" => items, "metric" => 42}
  end

  # Drive an execute, servicing each tool_call with `responder`, until the
  # execute result/error frame for `exec_id` lands.
  defp run_execute(peer, exec_id, program, responder, max_heap_mb \\ nil) do
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

        H.send_frame(peer, %{
          "jsonrpc" => "2.0",
          "id" => call_id,
          "result" => responder.(tool, args)
        })

        service(peer, exec_id, responder)

      true ->
        service(peer, exec_id, responder)
    end
  end

  describe "large tool result offload" do
    test "count over a parked dashboard succeeds under a tight heap", %{peer: peer} do
      responder = fn "big", _ -> big_payload() end
      program = ~S|(count (get (tool/big {}) "items"))|

      assert {:ok, 400} = run_execute(peer, 1, program, responder)
    end

    test "DECISIVE: the SAME program OOMs without offload, succeeds with it", %{peer: peer} do
      # The control: run the program directly through Lisp.run (no Peer, no
      # offload) under a tight heap — the big result lands on the sandbox heap
      # and OOMs. This is the pre-PATCH-3 E1 failure, reproduced.
      big = %{"items" => for(i <- 1..2_000, do: %{"id" => i, "body" => String.duplicate("x", 2_000)})}
      tools = %{"big" => fn _ -> big end}
      program = ~S|(count (get (tool/big {}) "items"))|

      assert {:error, step} = PtcRunner.Lisp.run(program, tools: tools, max_heap: 200_000)
      assert step.fail.reason == :memory_exceeded

      # The experiment: the SAME program through the Peer (which parks the
      # result) under a TIGHT 1MB sandbox heap (FEAT-791 max_heap_mb) succeeds
      # — the ~4MB result never touches the sandbox heap, only the parked
      # handle + the final count do. Without offload this heap would OOM
      # exactly as the control above (4MB ≫ 1MB, shared binaries counted).
      responder = fn "big", _ -> big end
      assert {:ok, 2_000} = run_execute(peer, 100, program, responder, 1)
    end

    test "select-keys + get project only the slice", %{peer: peer} do
      responder = fn "big", _ -> big_payload() end
      # Pull one scalar field and a count — never the bodies.
      program = ~S|{"n" (count (get (tool/big {}) "items")) "metric" (get (tool/big {}) "metric")}|

      assert {:ok, %{"n" => 400, "metric" => 42}} = run_execute(peer, 2, program, responder)
    end

    test "small results are NOT parked — returned verbatim, fully usable", %{peer: peer} do
      responder = fn "small", _ -> %{"items" => [1, 2, 3], "ok" => true} end
      program = ~S|(get (tool/small {}) "items")|

      assert {:ok, [1, 2, 3]} = run_execute(peer, 3, program, responder)
    end

    test "first + nth project a parked list", %{peer: peer} do
      responder = fn "big", _ -> %{"items" => Enum.to_list(1..100_000)} end
      program = ~S|(nth (get (tool/big {}) "items") 5)|

      assert {:ok, 6} = run_execute(peer, 4, program, responder)
    end

    test "take projects a handle whose position is LAST, not first (regression)", %{peer: peer} do
      # (take n coll) puts the handle last; the projection must locate it by
      # predicate, not position, or it crashes FunctionClauseError.
      responder = fn "big", _ -> %{"items" => Enum.to_list(1..100_000)} end
      program = ~S|(take 3 (get (tool/big {}) "items"))|

      assert {:ok, [1, 2, 3]} = run_execute(peer, 8, program, responder)
    end

    test "a large bare-STRING tool result is parked and projectable", %{peer: peer} do
      # A tool returning a multi-MB string (file body / HTML) must offload too,
      # not land on the sandbox heap. Count under a tight 1MB heap proves it.
      big_string = String.duplicate("abcdefghij", 100_000)
      responder = fn "big", _ -> big_string end
      program = ~S|(count (tool/big {}))|

      assert {:ok, 1_000_000} = run_execute(peer, 9, program, responder, 1)
    end

    test "a non-projectable op realizes the handle (correctness fallback)", %{peer: peer} do
      # `reduce` is not handle-projectable; the handle is realized and summed.
      responder = fn "big", _ -> %{"nums" => Enum.to_list(1..100)} end
      program = ~S|(reduce + 0 (get (tool/big {}) "nums"))|

      assert {:ok, 5050} = run_execute(peer, 5, program, responder)
    end
  end

  describe "handle introspection (W2b)" do
    test "handle-meta reports cost/shape WITHOUT realizing the value", %{peer: peer} do
      responder = fn "big", _ -> big_payload() end
      # Read the parked value's shape under a TIGHT heap: realizing it would
      # OOM, so a passing result proves handle-meta never touches the term.
      program = ~S|(handle-meta (tool/big {}))|

      assert {:ok, meta} = run_execute(peer, 200, program, responder, 1)
      assert meta["shape"] == "map"
      assert "items" in meta["keys"]
      assert meta["bytes"] > 256_000
    end

    test "handle? is true for a parked result, false for a small one", %{peer: peer} do
      big = fn "big", _ -> big_payload() end
      small = fn "small", _ -> %{"x" => 1} end
      assert {:ok, true} = run_execute(peer, 201, ~S|(handle? (tool/big {}))|, big)
      assert {:ok, false} = run_execute(peer, 202, ~S|(handle? (tool/small {}))|, small)
    end
  end

  describe "handle GC across executes" do
    test "a handle from a prior execute is released and can't leak", %{peer: peer} do
      # Two sequential executes; the store releases exec 6's bucket on its
      # completion, so nothing from it survives into exec 7. We can't observe
      # the internal store from here, but we assert both run cleanly — the
      # release path is exercised and unit-tested in handle_store_test.exs.
      responder = fn "big", _ -> big_payload() end
      assert {:ok, 400} = run_execute(peer, 6, ~S|(count (get (tool/big {}) "items"))|, responder)
      assert {:ok, 400} = run_execute(peer, 7, ~S|(count (get (tool/big {}) "items"))|, responder)
    end

    test "an in-closure projection re-parks under the live exec_id (no nil leak)", %{peer: peer} do
      # A `get` INSIDE a closure body whose result is itself oversized re-parks
      # a nested handle. If the closure context dropped exec_id, that nested
      # term would bucket under nil and survive release — a leak. Assert the
      # program runs AND the store's unreleasable nil bucket stays empty.
      big_inner = %{"inner" => for(i <- 1..400, do: %{"id" => i, "body" => String.duplicate("y", 2_000)})}
      responder = fn "big", _ -> %{"a" => big_inner, "b" => big_inner} end

      program = ~S|(count (map (fn [k] (handle? (get (tool/big {}) k))) ["a" "b"]))|
      assert {:ok, 2} = run_execute(peer, 300, program, responder, 1)

      assert %{count: 0} = PtcRunner.Lisp.HandleStore.stats(PtcRunner.Lisp.HandleStore, nil)
    end
  end
end
