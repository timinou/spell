defmodule PtcRuntime.BridgeTest do
  @moduledoc """
  Unit tests for the catalog → PTC-Lisp tools map (bridge BEAM half).

  The bridge's *runtime* behavior (callbacks routing to Node) is covered by the
  reentrant tool_call tests in `peer_test.exs`; here we test the pure mapping
  from a catalog to a tools map, in isolation from the Peer.
  """
  use ExUnit.Case, async: true

  alias PtcRuntime.Bridge

  describe "build_tools/2" do
    test "wires one callback per named catalog tool" do
      catalog = %{"tools" => [%{"name" => "find"}, %{"name" => "org"}, %{"name" => "memory"}]}
      tools = Bridge.build_tools(catalog, self())

      assert Bridge.tool_names(tools) == ["find", "memory", "org"]
      assert is_function(Map.fetch!(tools, "find"), 1)
    end

    test "ignores entries without a usable name" do
      catalog = %{
        "tools" => [
          %{"name" => "ok"},
          %{"name" => ""},
          %{"name" => nil},
          %{"description" => "no name"},
          %{}
        ]
      }

      assert Bridge.tool_names(Bridge.build_tools(catalog, self())) == ["ok"]
    end

    test "empty / missing catalog yields no tools" do
      assert Bridge.build_tools(%{}, self()) == %{}
      assert Bridge.build_tools(%{"tools" => []}, self()) == %{}
    end

    test "a wired callback routes through the given peer" do
      # The callback should GenServer.call the peer with {:tool_call, name, args, exec_id}.
      # We stand in as the peer process and assert the message shape, replying so
      # the callback returns.
      tools = Bridge.build_tools(%{"tools" => [%{"name" => "echo"}]}, self())
      cb = Map.fetch!(tools, "echo")

      task = Task.async(fn -> cb.(%{"msg" => "hi"}) end)

      assert_receive {:"$gen_call", from, {:tool_call, "echo", %{"msg" => "hi"}, _exec_id}}, 1_000
      GenServer.reply(from, {:ok, %{"echoed" => "hi"}})

      assert Task.await(task) == %{"echoed" => "hi"}
    end

    test "a callback raises when the peer returns an error (sandbox surfaces it)" do
      tools = Bridge.build_tools(%{"tools" => [%{"name" => "boom"}]}, self())
      cb = Map.fetch!(tools, "boom")

      # Run the callback in an unlinked process so its raise doesn't fail the
      # test; capture the crash and assert the tool error surfaced.
      {pid, ref} = spawn_monitor(fn -> cb.(%{}) end)
      assert_receive {:"$gen_call", from, {:tool_call, "boom", %{}, _exec_id}}, 1_000
      GenServer.reply(from, {:error, %{"message" => "nope"}})

      assert_receive {:DOWN, ^ref, :process, ^pid, reason}, 1_000
      assert match?({%RuntimeError{}, _}, reason)
    end
  end
end
