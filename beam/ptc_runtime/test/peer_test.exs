defmodule PtcRuntime.PeerTest do
  use ExUnit.Case, async: true

  alias PtcRuntime.PeerHarness, as: H

  describe "init" do
    test "hydrates catalog and echoes wired tool names" do
      peer = H.start()

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "init",
        "params" => %{"catalog" => %{"tools" => [%{"name" => "find"}, %{"name" => "org"}]}}
      })

      assert %{"id" => 1, "result" => %{"ok" => true, "tools" => tools}} = H.recv()
      assert tools == ["find", "org"]
    end
  end

  describe "execute" do
    setup do
      peer = H.start()
      H.send_frame(peer, %{"jsonrpc" => "2.0", "id" => 0, "method" => "init", "params" => %{}})
      assert %{"id" => 0, "result" => _} = H.recv()
      {:ok, peer: peer}
    end

    test "pure compute round-trips", %{peer: peer} do
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 7,
        "method" => "execute",
        "params" => %{"program" => "(+ 1 2)"}
      })

      assert %{"id" => 7, "result" => 3} = H.recv()
    end

    test "signature returns a string-keyed map", %{peer: peer} do
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 8,
        "method" => "execute",
        "params" => %{
          "program" => "{:total (count data/xs)}",
          "context" => %{"xs" => [1, 2, 3]},
          "signature" => "{total :int}"
        }
      })

      assert %{"id" => 8, "result" => %{"total" => 3}} = H.recv()
    end

    test "lisp error maps to a JSON-RPC error with reason", %{peer: peer} do
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 9,
        "method" => "execute",
        "params" => %{"program" => "(loop [i 0] (recur (inc i)))", "timeout_ms" => 200}
      })

      assert %{"id" => 9, "error" => %{"message" => msg, "data" => data}} = H.recv()
      assert is_binary(msg)
      assert data["reason"] in ["loop_limit_exceeded", "timeout"]
    end

    test "execute before init is rejected" do
      peer = H.start()

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => "(+ 1 1)"}
      })

      assert %{"id" => 1, "error" => %{"code" => -32_001}} = H.recv()
    end
  end

  describe "reentrant tool_call bridge (the seam)" do
    setup do
      peer = H.start()

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 0,
        "method" => "init",
        "params" => %{"catalog" => %{"tools" => [%{"name" => "echo"}, %{"name" => "sq"}]}}
      })

      assert %{"id" => 0, "result" => _} = H.recv()
      {:ok, peer: peer}
    end

    test "a program's (tool/echo ...) round-trips through Node", %{peer: peer} do
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 10,
        "method" => "execute",
        "params" => %{"program" => ~S|(tool/echo {:msg "hi"})|}
      })

      # BEAM issues a reentrant tool_call request to Node.
      tc = H.recv()
      assert %{"method" => "tool_call", "id" => tc_id, "params" => p} = tc
      assert p["tool"] == "echo"
      assert p["args"] == %{"msg" => "hi"}

      # Node responds with the tool result.
      H.send_frame(peer, %{"jsonrpc" => "2.0", "id" => tc_id, "result" => %{"echoed" => "hi"}})

      # The execute completes with the program's value.
      assert %{"id" => 10, "result" => %{"echoed" => "hi"}} = H.recv()
    end

    test "pmap fan-out issues concurrent tool_calls, all serviced", %{peer: peer} do
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 11,
        "method" => "execute",
        "params" => %{"program" => ~S|(pmap (fn [x] (tool/sq {:n x})) [1 2 3 4])|}
      })

      # Each (tool/sq) blocks its pmap worker until Node responds. Workers may
      # all be in flight at once, so we service tool_calls as they arrive and
      # stop when the execute result lands.
      result = service_until_result(peer, 11, fn args -> args["n"] * args["n"] end)
      assert result == [1, 4, 9, 16]
    end
  end

  # Drain outbound frames: respond to every tool_call with `fun.(args)`, return
  # the `result` of the execute frame with `exec_id`.
  defp service_until_result(peer, exec_id, fun, timeout \\ 3_000) do
    frame = H.recv(timeout)

    cond do
      Map.get(frame, "id") == exec_id and Map.has_key?(frame, "result") ->
        frame["result"]

      frame["method"] == "tool_call" ->
        H.send_frame(peer, %{
          "jsonrpc" => "2.0",
          "id" => frame["id"],
          "result" => fun.(frame["params"]["args"])
        })

        service_until_result(peer, exec_id, fun, timeout)

      true ->
        service_until_result(peer, exec_id, fun, timeout)
    end
  end
end
