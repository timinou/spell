defmodule SpellAgent.FindTest do
  @moduledoc """
  FEAT-042: the find / find-edges / edit tools backed by the Rust kernel NIF,
  bounded + panic-safe (BUG-028).
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Find

  describe "find_tool/1" do
    test "resolves a real file CodePath to nodes" do
      result = Find.find_tool(%{"target" => "lib/spell_agent/find.ex", "root" => "."})
      assert is_map(result)
      assert Map.has_key?(result, "nodes")
      assert length(result["nodes"]) >= 1
    end

    test "a missing :target returns an error map (never crashes)" do
      assert %{"error" => msg} = Find.find_tool(%{})
      assert msg =~ "target"
    end

    test "an over-size :target is rejected BEFORE the NIF (BUG-028 bound)" do
      huge = String.duplicate("x", 100_000)
      assert %{"error" => msg} = Find.find_tool(%{"target" => huge})
      assert msg =~ "exceeds"
    end

    test "an over-size :root is also bounded (S4 P1)" do
      huge = String.duplicate("x", 100_000)
      assert %{"error" => msg} = Find.find_tool(%{"target" => "lib/foo.ex", "root" => huge})
      assert msg =~ "exceeds"
    end
  end

  describe "find_edges_tool/1" do
    test "resolves a graph-edge query (callers via def→)" do
      result = Find.find_edges_tool(%{"target" => "lib/spell_agent/tools.ex::define_tool def→"})
      assert is_map(result)
      # either nodes (found) or a clean error — never a crash.
      assert Map.has_key?(result, "nodes") or Map.has_key?(result, "error")
    end

    test "a missing :target returns an error map" do
      assert %{"error" => _} = Find.find_edges_tool(%{})
    end
  end

  describe "edit_tool/2" do
    test "a missing :action returns an error map" do
      assert %{"error" => msg} = Find.edit_tool(%{"target" => "foo.ex"})
      assert msg =~ "action"
    end

    test "a missing :target returns an error map" do
      assert %{"error" => msg} = Find.edit_tool(%{"action" => "{}"})
      assert msg =~ "target"
    end

    test "an over-size :action is rejected before the NIF" do
      huge_action = String.duplicate("x", 100_000)
      assert %{"error" => msg} = Find.edit_tool(%{"target" => "foo.ex", "action" => huge_action})
      assert msg =~ "exceeds"
    end

    test "an ABSOLUTE target is rejected (S4 P1: no writes outside the workspace)" do
      assert %{"error" => msg} = Find.edit_tool(%{"target" => "/etc/passwd", "action" => "{}"})
      assert msg =~ "absolute" or msg =~ "workspace"
    end

    test "a `..` traversal target is rejected (S4 P1)" do
      assert %{"error" => msg} = Find.edit_tool(%{"target" => "../../secret.ex", "action" => "{}"})
      assert msg =~ "traversal" or msg =~ ".."
    end

    test "a map :action is JSON-encoded (accepted shape)" do
      # An unencodable action would error; a plain map encodes fine, so the target
      # resolution proceeds (and may error on a bogus target — but NOT on the action
      # shape). We assert the error, if any, is NOT about the action being invalid.
      result = Find.edit_tool(%{"target" => "nonexistent.ex", "action" => %{"kind" => "noop"}})
      assert is_map(result)

      case result do
        %{"error" => msg} -> refute msg =~ "action is required"
        _ -> :ok
      end
    end
  end

  describe "registry integration (FEAT-042)" do
    test "find/find-edges/edit are in the tools map and the inventory" do
      tools = SpellAgent.Tools.build_tools_map()
      assert Map.has_key?(tools, "find")
      assert Map.has_key?(tools, "find-edges")
      assert Map.has_key?(tools, "edit")

      names = Enum.map(SpellAgent.Tools.inventory(), & &1["name"])
      assert "tool/find" in names
      assert "tool/edit" in names
    end

    test "a define-tool cannot shadow find/edit (reserved)" do
      assert_raise ArgumentError, ~r/reserved/, fn ->
        SpellAgent.Tools.define_tool(%{"name" => "find", "params" => [], "source" => "1"})
      end

      assert_raise ArgumentError, ~r/reserved/, fn ->
        SpellAgent.Tools.define_tool(%{"name" => "edit", "params" => [], "source" => "1"})
      end
    end
  end
end
