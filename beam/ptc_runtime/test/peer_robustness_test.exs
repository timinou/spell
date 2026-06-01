defmodule PtcRuntime.PeerRobustnessTest do
  @moduledoc """
  Regression tests for Review Gate 0 findings (P0/P1/P2).
  """
  use ExUnit.Case, async: true

  alias PtcRuntime.PeerHarness, as: H

  defp init!(peer, catalog \\ %{}) do
    H.send_frame(peer, %{"jsonrpc" => "2.0", "id" => 0, "method" => "init", "params" => %{"catalog" => catalog}})
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
      H.send_frame(peer, %{"jsonrpc" => "2.0", "id" => 2, "method" => "execute", "params" => %{"program" => "(+ 2 3)"}})
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
end
