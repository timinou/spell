defmodule SpellAgent.Test.DSLGenerators do
  @moduledoc """
  Property-based test generators for the homoiconic tool DSL.
  Tests that the DSL maintains its invariants across random inputs.
  """

  use ExUnitProperties
  
  @doc "Generate valid PTC-Lisp source code"
  def valid_ptc_source_gen do
    one_of([
      # Simple literals
      constant("42"),
      constant("\"hello\""),
      constant("true"),
      constant("nil"),
      
      # Basic operations
      gen_arithmetic(),
      gen_string_ops(),
      gen_collection_ops(),
      
      # Tool calls
      gen_tool_call(),
      
      # Control flow
      gen_conditional(),
      gen_let_binding()
    ])
  end

  @doc "Generate invalid PTC source that should be rejected"
  def invalid_ptc_gen do
    one_of([
      # Missing parens
      constant("tool/find {:target \"foo\"}"),
      
      # Unbalanced parens
      constant("(+ 1 2"),
      constant("+ 1 2)"),
      
      # Invalid function calls
      constant("(undefined-function 123)"),
      
      # Bad syntax
      constant("(let [x] x)"),  # Missing binding value
      constant("(if true)"),    # Missing branches
      
      # Type errors
      constant("(+ \"string\" 42)"),
      
      # Infinite loops (should hit iteration limit)
      constant("(loop [] (recur))")
    ])
  end

  @doc "Generate tool definition maps"
  def tool_definition_gen do
    gen all name <- tool_name_gen(),
            params <- list_of(param_name_gen(), max_length: 5),
            doc <- string(:printable, max_length: 100),
            source <- valid_ptc_source_gen() do
      %{
        "name" => name,
        "params" => params,
        "doc" => doc,
        "source" => source
      }
    end
  end

  @doc "Generate sequences of telemetry events"
  def telemetry_event_stream_gen do
    gen all events <- list_of(telemetry_event_gen(), min_length: 1, max_length: 50) do
      ensure_valid_sequence(events)
    end
  end

  @doc "Generate a single telemetry event"
  def telemetry_event_gen do
    one_of([
      gen_span_start_event(),
      gen_span_stop_event(),
      gen_turn_event(),
      gen_tool_event()
    ])
  end

  @doc "Generate span forests with valid parent-child relationships"
  def valid_forest_gen do
    gen all root_count <- integer(1..5),
            depth <- integer(1..5),
            width <- integer(1..3) do
      generate_forest(root_count, depth, width)
    end
  end

  @doc "Generate UI state for property testing"
  def ui_state_gen do
    gen all cursor <- integer(0..100),
            row_count <- integer(1..100),
            auto_depth <- integer(0..10),
            collapsed <- map_of(span_id_gen(), boolean()) do
      %{
        cursor: min(cursor, row_count - 1),
        row_count: row_count,
        auto_depth: auto_depth,
        overrides: %{collapsed: collapsed}
      }
    end
  end

  @doc "Generate cursor operations"
  def cursor_operation_gen do
    one_of([
      constant({:move, 1}),
      constant({:move, -1}),
      constant({:move, 10}),
      constant({:move, -10}),
      constant({:set, 0}),
      gen all pos <- integer(0..100) do
        {:set, pos}
      end
    ])
  end

  # Private generators

  defp gen_arithmetic do
    gen all op <- member_of(["+", "-", "*", "/"]),
            a <- integer(-100..100),
            b <- integer(1..100) do
      "(#{op} #{a} #{b})"
    end
  end

  defp gen_string_ops do
    gen all s1 <- string(:alphanumeric, max_length: 20),
            s2 <- string(:alphanumeric, max_length: 20) do
      "(str \"#{s1}\" \"#{s2}\")"
    end
  end

  defp gen_collection_ops do
    one_of([
      # List operations
      gen all items <- list_of(integer(), max_length: 5) do
        items_str = Enum.join(items, " ")
        "(list #{items_str})"
      end,
      
      # Map operations
      gen all keys <- list_of(atom_gen(), min_length: 1, max_length: 3),
              vals <- list_of(integer(), min_length: 1, max_length: 3) do
        pairs = Enum.zip(keys, vals)
          |> Enum.map(fn {k, v} -> ":#{k} #{v}" end)
          |> Enum.join(" ")
        "{#{pairs}}"
      end
    ])
  end

  defp gen_tool_call do
    gen all tool <- member_of(["find", "memory", "org"]),
            args <- tool_args_gen(tool) do
      "(tool/#{tool} #{args})"
    end
  end

  defp tool_args_gen("find") do
    gen all target <- string(:alphanumeric, min_length: 1, max_length: 20) do
      "{:target \"#{target}\"}"
    end
  end

  defp tool_args_gen("memory") do
    gen all action <- member_of(["search", "save", "note"]),
            text <- string(:alphanumeric, max_length: 50) do
      "{:action \"#{action}\" :text \"#{text}\"}"
    end
  end

  defp tool_args_gen("org") do
    constant("{:command \"query\"}")
  end

  defp gen_conditional do
    gen all condition <- boolean(),
            then_val <- integer(),
            else_val <- integer() do
      "(if #{condition} #{then_val} #{else_val})"
    end
  end

  defp gen_let_binding do
    gen all var <- atom_gen(),
            val <- integer(),
            body <- integer() do
      "(let [#{var} #{val}] (+ #{var} #{body}))"
    end
  end

  defp tool_name_gen do
    gen all prefix <- member_of(["get", "find", "list", "check", "validate"]),
            suffix <- string(:alphanumeric, min_length: 1, max_length: 10) do
      "#{prefix}-#{suffix}"
    end
  end

  defp param_name_gen do
    gen all name <- string(:alphanumeric, min_length: 1, max_length: 10) do
      String.to_atom(name)
    end
  end

  defp span_id_gen do
    gen all prefix <- member_of(["run", "tool", "llm"]),
            num <- integer(1..1000) do
      "#{prefix}-#{num}"
    end
  end

  defp atom_gen do
    gen all s <- string(:alphanumeric, min_length: 1, max_length: 10) do
      String.to_atom(s)
    end
  end

  defp gen_span_start_event do
    gen all id <- span_id_gen(),
            parent <- one_of([constant(nil), span_id_gen()]),
            kind <- member_of([:run, :tool, :llm]) do
      {:start, kind, id, parent}
    end
  end

  defp gen_span_stop_event do
    gen all id <- span_id_gen(),
            status <- member_of([:ok, :error]) do
      {:stop, id, status}
    end
  end

  defp gen_turn_event do
    gen all number <- integer(1..10),
            phase <- member_of([:prompt, :thinking, :tool_use]) do
      {:turn, number, phase}
    end
  end

  defp gen_tool_event do
    gen all name <- tool_name_gen(),
            result <- one_of([constant(:ok), constant(:error)]) do
      {:tool, name, result}
    end
  end

  defp ensure_valid_sequence(events) do
    # Ensure every stop has a corresponding start
    events
    |> Enum.reduce({[], MapSet.new()}, fn
      {:start, kind, id, parent}, {acc, started} ->
        {[{:start, kind, id, parent} | acc], MapSet.put(started, id)}
        
      {:stop, id, status}, {acc, started} ->
        if MapSet.member?(started, id) do
          {[{:stop, id, status} | acc], MapSet.delete(started, id)}
        else
          # Skip stops without starts
          {acc, started}
        end
        
      other, {acc, started} ->
        {[other | acc], started}
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  defp generate_forest(root_count, max_depth, width) do
    roots = for i <- 1..root_count do
      id = "root-#{i}"
      span = %{
        id: id,
        parent_id: nil,
        kind: :run,
        status: Enum.random([:ok, :error, :running])
      }
      {id, span}
    end
    
    all_spans = Enum.reduce(roots, %{}, fn {id, span}, acc ->
      Map.put(acc, id, span)
    end)
    
    # Generate children recursively
    Enum.reduce(roots, all_spans, fn {root_id, _}, acc ->
      generate_children(acc, root_id, 1, max_depth, width)
    end)
  end

  defp generate_children(spans, parent_id, depth, max_depth, width) when depth > max_depth do
    spans
  end

  defp generate_children(spans, parent_id, depth, max_depth, width) do
    child_count = :rand.uniform(width)
    
    Enum.reduce(1..child_count, spans, fn i, acc ->
      child_id = "#{parent_id}-child-#{i}"
      child = %{
        id: child_id,
        parent_id: parent_id,
        kind: Enum.random([:tool, :llm]),
        status: Enum.random([:ok, :error, :running])
      }
      
      acc
      |> Map.put(child_id, child)
      |> generate_children(child_id, depth + 1, max_depth, width)
    end)
  end
end