defmodule PtcRuntime.PeerRobustnessTest do
  @moduledoc """
  Regression tests for Review Gate 0 findings (P0/P1/P2).
  """
  use ExUnit.Case, async: true

  alias PtcRuntime.PeerHarness, as: H

  defp init!(peer, catalog \\ %{}) do
    H.send_frame(peer, %{
      "jsonrpc" => "2.0",
      "id" => 0,
      "method" => "init",
      "params" => %{"catalog" => catalog}
    })

    assert %{"id" => 0, "result" => _} = H.recv()
  end

  describe "P1: non-encodable return does not crash the Peer" do
    test "a closure return becomes a clean execute error, runtime survives" do
      peer = H.start()
      init!(peer)

      # (fn [x] x) returns a closure ptc_runner represents as a non-JSON term.
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => "(fn [x] x)"}
      })

      assert %{"id" => 1, "error" => %{"data" => %{"reason" => "unencodable_return"}}} = H.recv()

      # Peer is alive and still serves subsequent executes.
      assert Process.alive?(peer)

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 2,
        "method" => "execute",
        "params" => %{"program" => "(+ 2 3)"}
      })

      assert %{"id" => 2, "result" => 5} = H.recv()
    end
  end

  describe "P2: tool_call caller death cleans up pending" do
    test "a worker that dies before Node responds leaves no dangling pending" do
      peer = H.start()
      init!(peer, %{"tools" => [%{"name" => "slow"}]})

      # Program calls a tool; we will NOT respond, then kill the execute proc by
      # letting the sandbox time out. The tool worker dies; pending must shrink.
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => ~S|(tool/slow {})|, "timeout_ms" => 300}
      })

      # Receive the outbound tool_call (worker now blocked awaiting our response).
      assert %{"method" => "tool_call", "id" => _tc_id} = H.recv()

      # Deliberately do NOT respond. The sandbox wall-timeout (300ms) kills the
      # worker; its :DOWN must drop the pending entry. The execute then errors.
      assert %{"id" => 1, "error" => _} = H.recv(2_000)

      # Give the monitor :DOWN time to process, then assert pending is empty via
      # a fresh tool_call cycle that reuses id space cleanly.
      Process.sleep(50)
      assert Process.alive?(peer)

      # A new execute + tool_call round-trips normally (no id confusion).
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 2,
        "method" => "execute",
        "params" => %{"program" => ~S|(tool/slow {})|}
      })

      assert %{"method" => "tool_call", "id" => tc2} = H.recv()
      H.send_frame(peer, %{"jsonrpc" => "2.0", "id" => tc2, "result" => "ok"})
      assert %{"id" => 2, "result" => "ok"} = H.recv()
    end
  end

  describe "P1 (gate 1): non-encodable tool_call args do not crash the Peer" do
    test "a program passing a closure as a tool arg gets a tool error, peer survives" do
      peer = H.start()
      init!(peer, %{"tools" => [%{"name" => "sink"}]})

      # The program passes a function as a tool arg. The outbound tool_call
      # frame cannot be JSON-encoded; the Peer must reply a tool error to the
      # worker (surfaced as an execute error) WITHOUT crashing.
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => ~S|(tool/sink {:f (fn [x] x)})|}
      })

      assert %{"id" => 1, "error" => _} = H.recv(2_000)
      assert Process.alive?(peer)

      # Runtime still serves normal work.
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 2,
        "method" => "execute",
        "params" => %{"program" => "(+ 1 1)"}
      })

      assert %{"id" => 2, "result" => 2} = H.recv()
    end
  end

  describe "framing robustness" do
    test "a JSON string containing escaped newlines survives round-trip" do
      peer = H.start()
      init!(peer)

      # The program builds a string with an embedded newline; the return value
      # must come back intact (JSON escapes it, so NDJSON framing is safe).
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => ~S|(str "line1" "\n" "line2")|}
      })

      assert %{"id" => 1, "result" => "line1\nline2"} = H.recv()
    end

    test "malformed inbound line yields a parse error, peer survives" do
      peer = H.start()
      H.send_line(peer, "}{ not json at all")
      assert %{"id" => nil, "error" => %{"code" => -32_700}} = H.recv()
      assert Process.alive?(peer)
    end
  end

  describe "PLAN-323: per-execute resource caps thread into ptc_runner" do
    test "a configured worker_max_heap caps each pmap worker's heap" do
      # With a tiny worker heap, a pmap that allocates must fail memory_exceeded
      # rather than run unbounded — proving the cap reaches PtcRunner.Lisp.run.
      peer = H.start(self(), worker_max_heap: 500)
      init!(peer)

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => ~S|(pmap (fn [x] (* x x)) [1 2 3 4])|, "timeout_ms" => 2_000}
      })

      assert %{"id" => 1, "error" => %{"data" => %{"reason" => "memory_exceeded"}}} =
               H.recv(3_000)

      assert Process.alive?(peer)
    end

    test "a configured max_parallel_workers caps aggregate parallel workers" do
      # max_parallel_workers=1 lets a flat pmap run but fails NESTED pmap with
      # parallel_capacity_exceeded — proving the cap reaches the run.
      peer = H.start(self(), max_parallel_workers: 1)
      init!(peer)

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{
          "program" => ~S|(pmap (fn [x] (pmap (fn [y] y) [x x])) [1 2 3])|,
          "timeout_ms" => 2_000
        }
      })

      assert %{"id" => 1, "error" => %{"data" => %{"reason" => "parallel_capacity_exceeded"}}} =
               H.recv(3_000)

      assert Process.alive?(peer)
    end
  end

  describe "FEAT-791: per-execute max_heap request param" do
    test "a per-execute max_heap overrides the session ceiling for that program" do
      # Session default would allow this allocation; a tiny per-execute
      # max_heap must fail it memory_exceeded — proving the param reaches
      # PtcRunner.Lisp.run for THIS execute.
      peer = H.start()
      init!(peer)

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{
          "program" => ~S|(reduce (fn [acc x] (str acc x)) "" (range 0 50000))|,
          "timeout_ms" => 5_000,
          "max_heap" => 2_000
        }
      })

      assert %{"id" => 1, "error" => %{"data" => %{"reason" => "memory_exceeded"}}} =
               H.recv(6_000)

      # The override was per-execute: the next program (no param) runs under
      # the session default and succeeds.
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 2,
        "method" => "execute",
        "params" => %{"program" => ~S|(+ 1 2)|}
      })

      assert %{"id" => 2, "result" => 3} = H.recv(2_000)
      assert Process.alive?(peer)
    end

    test "a non-integer max_heap is ignored (session default applies)" do
      peer = H.start()
      init!(peer)

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => ~S|(+ 1 1)|, "max_heap" => "lots"}
      })

      assert %{"id" => 1, "result" => 2} = H.recv(2_000)
    end
  end

  describe "PLAN-323: concurrent-execute admission ceiling" do
    test "rejects an execute beyond the concurrent ceiling, accepts again after one drains" do
      # Ceiling of 1: while one execute is in flight (blocked on a tool_call we
      # withhold), a second execute is rejected with a clean, retryable error
      # rather than spawning an unbounded N×80MB worker set.
      peer = H.start(self(), max_concurrent_executes: 1)
      init!(peer, %{"tools" => [%{"name" => "slow"}]})

      # Execute #1 calls a tool; we withhold the response so it stays in flight.
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => ~S|(tool/slow {})|}
      })

      assert %{"method" => "tool_call", "id" => tc1} = H.recv()

      # Execute #2 arrives while #1 occupies the only slot → rejected.
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 2,
        "method" => "execute",
        "params" => %{"program" => ~S|(+ 1 1)|}
      })

      assert %{"id" => 2, "error" => %{"code" => code, "message" => msg}} = H.recv(2_000)
      assert code == -32_004
      assert msg =~ "concurrent"

      # Drain #1 by responding to its tool_call.
      H.send_frame(peer, %{"jsonrpc" => "2.0", "id" => tc1, "result" => "ok"})
      assert %{"id" => 1, "result" => "ok"} = H.recv(2_000)

      # Slot freed → a new execute is admitted.
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 3,
        "method" => "execute",
        "params" => %{"program" => ~S|(+ 2 2)|}
      })

      assert %{"id" => 3, "result" => 4} = H.recv(2_000)
    end
  end
end
