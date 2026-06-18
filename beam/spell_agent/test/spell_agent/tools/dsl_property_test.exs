defmodule SpellAgent.Tools.DSLPropertyTest do
  @moduledoc """
  Property-based tests for the homoiconic tool DSL.
  Validates that the DSL maintains its core invariants across random inputs.
  """

  use ExUnit.Case
  use ExUnitProperties
  
  import SpellAgent.Test.DSLGenerators
  alias SpellAgent.{Tools, ToolRegistry, Config}

  setup do
    # Clean registry before each test
    ToolRegistry.start_link(name: nil)
    Config.start_link(name: nil)
    
    on_exit(fn ->
      # Cleanup
      :ok
    end)
    
    :ok
  end

  describe "Tool Definition Invariants" do
    property "valid PTC source can always be defined as a tool" do
      check all source <- valid_ptc_source_gen(),
                name <- tool_name_gen(),
                max_runs: 100 do
        
        result = Tools.define_tool(%{
          "name" => name,
          "source" => source,
          "params" => [],
          "doc" => "Generated tool"
        })
        
        assert match?(%{"ok" => true, "defined" => ^name}, result)
        
        # Verify it's in the registry
        assert ToolRegistry.get(name)
      end
    end

    property "invalid PTC is rejected at define-time" do
      check all invalid <- invalid_ptc_gen(),
                name <- tool_name_gen() do
        
        assert_raise ArgumentError, ~r/invalid PTC source/, fn ->
          Tools.define_tool(%{
            "name" => name,
            "source" => invalid,
            "params" => []
          })
        end
        
        # Verify it wasn't registered
        refute ToolRegistry.get(name)
      end
    end

    property "tools preserve referential transparency" do
      check all a <- integer(-100..100),
                b <- integer(1..100) do
        
        # Define a deterministic tool
        name = "adder-#{System.unique_integer([:positive])}"
        
        Tools.define_tool(%{
          "name" => name,
          "source" => "(+ data/a data/b)",
          "params" => [:a, :b]
        })
        
        # Call it multiple times with same args
        tools_map = Tools.build_tools_map()
        tool_fn = Map.get(tools_map, name)
        
        result1 = tool_fn.(%{"a" => a, "b" => b})
        result2 = tool_fn.(%{"a" => a, "b" => b})
        result3 = tool_fn.(%{"a" => a, "b" => b})
        
        # All results must be identical
        assert result1 == result2
        assert result2 == result3
        assert result1 == a + b
      end
    end

    property "meta-tools cannot be overridden" do
      check all name <- member_of(["define-tool", "define-config", "list-tools"]) do
        
        assert_raise ArgumentError, ~r/cannot redefine reserved/, fn ->
          Tools.define_tool(%{
            "name" => name,
            "source" => "42",
            "params" => []
          })
        end
      end
    end

    property "tool composition preserves execution" do
      check all base_value <- integer(1..100) do
        
        # Define a base tool
        base_name = "base-#{System.unique_integer([:positive])}"
        Tools.define_tool(%{
          "name" => base_name,
          "source" => "#{base_value}",
          "params" => []
        })
        
        # Define a tool that calls the base
        composed_name = "composed-#{System.unique_integer([:positive])}"
        Tools.define_tool(%{
          "name" => composed_name,
          "source" => "(* 2 (tool/#{base_name} {}))",
          "params" => []
        })
        
        # Execute composed tool
        tools_map = Tools.build_tools_map()
        result = tools_map[composed_name].(%{})
        
        assert result == base_value * 2
      end
    end
  end

  describe "Parameter Binding" do
    property "params are correctly bound in tool body" do
      check all params <- list_of(param_name_gen(), min_length: 1, max_length: 5),
                values <- list_of(integer(), length: length(params)) do
        
        name = "param-test-#{System.unique_integer([:positive])}"
        
        # Build source that uses all params
        param_refs = params |> Enum.map(&"data/#{&1}") |> Enum.join(" ")
        source = "(list #{param_refs})"
        
        Tools.define_tool(%{
          "name" => name,
          "source" => source,
          "params" => params
        })
        
        # Build args map
        args = params
          |> Enum.zip(values)
          |> Map.new(fn {p, v} -> {Atom.to_string(p), v} end)
        
        # Execute
        tools_map = Tools.build_tools_map()
        result = tools_map[name].(args)
        
        assert result == values
      end
    end

    property "missing params result in nil" do
      check all param <- param_name_gen() do
        
        name = "missing-param-#{System.unique_integer([:positive])}"
        
        Tools.define_tool(%{
          "name" => name,
          "source" => "(str \"value: \" data/#{param})",
          "params" => [param]
        })
        
        # Call without providing the param
        tools_map = Tools.build_tools_map()
        result = tools_map[name].(%{})
        
        assert result == "value: "
      end
    end
  end

  describe "Tool Registry Consistency" do
    property "registry maintains uniqueness" do
      check all definitions <- list_of(tool_definition_gen(), min_length: 1, max_length: 10) do
        
        # Use same name for all
        name = "unique-test"
        
        # Define multiple times with different bodies
        for defn <- definitions do
          Tools.define_tool(Map.put(defn, "name", name))
        end
        
        # Registry should have exactly one entry
        all_tools = ToolRegistry.all()
        matching = Enum.filter(all_tools, &(&1.name == name))
        
        assert length(matching) == 1
        
        # It should be the last definition
        last_defn = List.last(definitions)
        assert hd(matching).source == last_defn["source"]
      end
    end

    property "list-tools reflects all defined tools" do
      check all definitions <- list_of(tool_definition_gen(), max_length: 20) do
        
        # Give each a unique name
        indexed_defs = definitions
          |> Enum.with_index()
          |> Enum.map(fn {defn, i} ->
            Map.put(defn, "name", "tool-#{i}")
          end)
        
        # Define all tools
        for defn <- indexed_defs do
          Tools.define_tool(defn)
        end
        
        # Get inventory
        inventory = Tools.inventory()
        
        # Check all defined tools appear
        for defn <- indexed_defs do
          assert Enum.any?(inventory, &(&1["name"] == defn["name"]))
        end
      end
    end
  end

  describe "Error Handling" do
    property "tool errors don't crash the system" do
      check all divisor <- integer(),
                name = "divider-#{System.unique_integer([:positive])}" do
        
        Tools.define_tool(%{
          "name" => name,
          "source" => "(/ 100 data/n)",
          "params" => [:n]
        })
        
        tools_map = Tools.build_tools_map()
        
        # Division by zero should raise, not crash
        if divisor == 0 do
          assert_raise RuntimeError, fn ->
            tools_map[name].(%{"n" => divisor})
          end
        else
          result = tools_map[name].(%{"n" => divisor})
          assert is_number(result)
        end
      end
    end

    property "malformed args are handled gracefully" do
      check all args <- one_of([
                  constant(nil),
                  constant([]),
                  constant("string"),
                  integer(),
                  list_of(integer())
                ]) do
        
        name = "robust-#{System.unique_integer([:positive])}"
        
        Tools.define_tool(%{
          "name" => name,
          "source" => "(str data/x \" \" data/y)",
          "params" => [:x, :y]
        })
        
        tools_map = Tools.build_tools_map()
        
        # Should handle non-map args
        result = tools_map[name].(args)
        
        # Should produce some string output
        assert is_binary(result)
      end
    end
  end

  describe "Config Integration" do
    property "define-config updates are visible" do
      check all key <- string(:alphanumeric, min_length: 1, max_length: 20),
                value <- one_of([string(:alphanumeric), integer(), boolean()]) do
        
        result = Tools.define_config(%{
          "key" => key,
          "value" => value
        })
        
        assert result["ok"] == true
        assert result["set"] == key
        
        # Config should reflect the value
        assert Config.get(key) == value
      end
    end
  end

  # Helper to generate unique tool names
  defp tool_name_gen do
    gen all base <- string(:alphanumeric, min_length: 3, max_length: 10) do
      base
    end
  end

  # Helper to generate parameter names
  defp param_name_gen do
    gen all name <- string(:alphanumeric, min_length: 1, max_length: 10) do
      String.to_atom(name)
    end
  end
end