defmodule SpellAgent.ToolsTest do
  use ExUnit.Case, async: false

  alias SpellAgent.{Config, Tools, ToolRegistry}

  setup do
    # The registry + config are session-global GenServers (started by the app).
    # Reset them between tests so cases don't leak defined tools into each other.
    for e <- ToolRegistry.all(), do: ToolRegistry.remove(e.name)
    Config.put("model", "claude-sonnet-4-5-20250929")
    :ok
  end

  defp call(name, args) do
    Tools.build_tools_map() |> Map.fetch!(name) |> then(& &1.(args))
  end

  describe "define-tool → stored PTC program is callable" do
    test "a defined arithmetic tool runs with args bound as data/<param>" do
      assert %{"ok" => true, "defined" => "double"} =
               Tools.define_tool(%{"name" => "double", "params" => ["n"], "source" => "(* 2 data/n)"})

      assert call("double", %{"n" => 21}) == 42
    end

    test "a defined tool can call a NATIVE tool (list-tools) — composition" do
      Tools.define_tool(%{"name" => "count-tools", "params" => [], "source" => "(count (tool/list-tools {}))"})
      # list-tools itself (3 meta) + count-tools just defined = 4
      assert call("count-tools", %{}) == 4
    end

    test "a defined tool can call ANOTHER defined tool" do
      Tools.define_tool(%{"name" => "inc", "params" => ["n"], "source" => "(+ 1 data/n)"})
      Tools.define_tool(%{"name" => "inc2", "params" => ["n"], "source" => "(tool/inc {:n (tool/inc {:n data/n})})"})
      assert call("inc2", %{"n" => 40}) == 42
    end
  end

  describe "validation + guards" do
    test "malformed PTC source is rejected at define time with a clear error" do
      assert_raise ArgumentError, ~r/invalid PTC source/, fn ->
        Tools.define_tool(%{"name" => "bad", "params" => [], "source" => "(+ 1 "})
      end

      assert ToolRegistry.get("bad") == :error
    end

    test "cannot redefine a reserved meta-tool" do
      assert_raise ArgumentError, ~r/reserved tool/, fn ->
        Tools.define_tool(%{"name" => "list-tools", "params" => [], "source" => "42"})
      end
    end

    test "missing name/source raises" do
      assert_raise ArgumentError, fn -> Tools.define_tool(%{"params" => [], "source" => "1"}) end
      assert_raise ArgumentError, fn -> Tools.define_tool(%{"name" => "x", "params" => []}) end
    end
  end

  describe "inventory + introspection" do
    test "list-tools surfaces meta-tools and runtime-defined tools as data" do
      Tools.define_tool(%{"name" => "blast", "params" => ["sym"], "doc" => "impact", "source" => "data/sym"})

      inv = call("list-tools", %{})
      names = Enum.map(inv, & &1["name"])

      assert "define-tool" in names
      assert "define-config" in names
      assert "list-tools" in names
      assert "blast" in names

      blast = Enum.find(inv, &(&1["name"] == "blast"))
      assert blast["params"] == ["sym"]
      assert blast["doc"] == "impact"
      assert blast["kind"] == "ptc"
    end

    test "a tool defined now appears in the inventory immediately (next-turn visibility)" do
      refute Enum.any?(Tools.inventory(), &(&1["name"] == "fresh"))
      Tools.define_tool(%{"name" => "fresh", "params" => [], "source" => "1"})
      assert Enum.any?(Tools.inventory(), &(&1["name"] == "fresh"))
    end
  end

  describe "define-config" do
    test "sets a whitelisted key" do
      assert %{"ok" => true, "set" => "model"} = Tools.define_config(%{"key" => "model", "value" => "claude-x"})
      assert Config.get("model") == "claude-x"
    end

    test "rejects an unknown key" do
      assert_raise ArgumentError, ~r/unknown config key/, fn ->
        Tools.define_config(%{"key" => "bogus", "value" => 1})
      end
    end
  end
end
