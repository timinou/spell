defmodule SpellAgent.Benchmarks.PerformanceTest do
  @moduledoc """
  Performance benchmarks for critical paths.
  Run with: mix test --only benchmark
  """

  use ExUnit.Case, async: false
  
  alias SpellAgent.{Tools, ToolRegistry, Config}
  alias SpellAgent.Tui.{Store, Ui}
  alias SpellAgent.Tui.Panes.SpanTree
  alias SpellAgent.Test.{HeadlessHarness, DSLGenerators}
  
  @tag :benchmark
  describe "Tool Execution Performance" do
    setup do
      {:ok, _registry} = ToolRegistry.start_link(name: nil)
      {:ok, _config} = Config.start_link(name: nil)
      :ok
    end

    @tag :benchmark
    test "simple tool invocation under 1ms" do
      Tools.define_tool(%{
        "name" => "adder",
        "params" => [:a, :b],
        "source" => "(+ data/a data/b)",
        "doc" => "Add two numbers"
      })
      
      tools_map = Tools.build_tools_map()
      tool = Map.get(tools_map, "adder")
      
      # Warmup
      for _ <- 1..10, do: tool.(%{"a" => 1, "b" => 2})
      
      {time, result} = :timer.tc(fn ->
        tool.(%{"a" => 42, "b" => 58})
      end)
      
      assert result == 100
      assert time < 1_000, "Tool execution took #{time}μs, expected < 1ms"
    end

    @tag :benchmark
    test "complex tool chain under 10ms" do
      # Define a chain of tools
      Tools.define_tool(%{
        "name" => "step1",
        "params" => [:x],
        "source" => "(* 2 data/x)"
      })
      
      Tools.define_tool(%{
        "name" => "step2",
        "params" => [:x],
        "source" => "(+ 10 (tool/step1 {:x data/x}))"
      })
      
      Tools.define_tool(%{
        "name" => "step3",
        "params" => [:x],
        "source" => "(str \"Result: \" (tool/step2 {:x data/x}))"
      })
      
      tools_map = Tools.build_tools_map()
      final_tool = Map.get(tools_map, "step3")
      
      # Warmup
      for _ <- 1..5, do: final_tool.(%{"x" => 5})
      
      {time, result} = :timer.tc(fn ->
        final_tool.(%{"x" => 10})
      end)
      
      assert result == "Result: 30"
      assert time < 10_000, "Tool chain took #{time}μs, expected < 10ms"
    end

    @tag :benchmark
    test "tool registry operations scale linearly" do
      measurements = for tool_count <- [10, 50, 100, 500] do
        # Clear registry
        for tool <- ToolRegistry.all() do
          # In real impl would have delete operation
        end
        
        # Define N tools
        {define_time, _} = :timer.tc(fn ->
          for i <- 1..tool_count do
            Tools.define_tool(%{
              "name" => "tool-#{i}",
              "params" => [:x],
              "source" => "(* data/x #{i})",
              "doc" => "Tool #{i}"
            })
          end
        end)
        
        # Measure lookup time
        {lookup_time, _} = :timer.tc(fn ->
          for i <- 1..tool_count do
            ToolRegistry.get("tool-#{i}")
          end
        end)
        
        # Measure inventory time
        {inventory_time, _} = :timer.tc(fn ->
          Tools.inventory()
        end)
        
        {tool_count, define_time, lookup_time, inventory_time}
      end
      
      # Check that time grows roughly linearly
      for {count, define_t, lookup_t, inv_t} <- measurements do
        # Define should be O(n)
        assert define_t / count < 1000, "Define time per tool > 1ms at count=#{count}"
        
        # Lookup should be O(n) for n lookups
        assert lookup_t / count < 100, "Lookup time per tool > 100μs at count=#{count}"
        
        # Inventory should be O(n)
        assert inv_t / count < 50, "Inventory time per tool > 50μs at count=#{count}"
      end
    end
  end

  @tag :benchmark
  describe "Store Performance" do
    setup do
      {:ok, store} = Store.start_link(name: nil)
      %{store: store}
    end

    @tag :benchmark
    test "handles 10k telemetry events under 1 second", %{store: store} do
      Store.attach(store)
      
      {time, _} = :timer.tc(fn ->
        for i <- 1..10_000 do
          # Alternate between start and stop events
          if rem(i, 2) == 0 do
            :telemetry.execute(
              [:ptc_runner, :sub_agent, :tool, :start],
              %{},
              %{
                span_id: "span-#{i}",
                parent_span_id: if(i > 2, do: "span-#{i-2}", else: nil),
                tool_name: "tool-#{i}"
              }
            )
          else
            :telemetry.execute(
              [:ptc_runner, :sub_agent, :tool, :stop],
              %{duration: 1000},
              %{span_id: "span-#{i-1}", status: :ok}
            )
          end
        end
        
        # Wait for processing
        Process.sleep(100)
      end)
      
      assert time < 1_000_000, "10k events took #{time}μs, expected < 1s"
      
      # Verify store has correct state
      spans = Store.spans(store)
      assert map_size(spans) == 5000  # Half are starts, half are stops
    end

    @tag :benchmark
    test "forest operations remain fast with deep trees", %{store: store} do
      # Create a deep tree (depth 100)
      for depth <- 1..100 do
        parent = if depth == 1, do: nil, else: "span-#{depth-1}"
        
        :telemetry.execute(
          [:ptc_runner, :sub_agent, :tool, :start],
          %{},
          %{
            span_id: "span-#{depth}",
            parent_span_id: parent,
            tool_name: "tool-#{depth}"
          }
        )
      end
      
      Process.sleep(50)
      spans = Store.spans(store)
      
      # Measure root finding
      {root_time, roots} = :timer.tc(fn ->
        Store.roots(store)
      end)
      
      assert length(roots) == 1
      assert root_time < 10_000, "Root finding took #{root_time}μs, expected < 10ms"
      
      # Measure subtree extraction
      {subtree_time, subtree} = :timer.tc(fn ->
        Store.subtree(spans, "span-1")
      end)
      
      assert map_size(subtree) == 100
      assert subtree_time < 10_000, "Subtree extraction took #{subtree_time}μs"
      
      # Measure children finding
      {children_time, children} = :timer.tc(fn ->
        for i <- 1..99 do
          Store.children(spans, "span-#{i}")
        end
      end)
      
      assert children_time < 10_000, "Children finding took #{children_time}μs"
    end
  end

  @tag :benchmark
  describe "TUI Rendering Performance" do
    setup do
      {:ok, store} = Store.start_link(name: nil)
      harness = HeadlessHarness.new(width: 120, height: 40)
      %{store: store, harness: harness}
    end

    @tag :benchmark
    test "renders 1000-span forest under 100ms", %{harness: harness} do
      # Generate a large forest
      forest = DSLGenerators.generate_forest(10, 5, 4)  # ~1000 nodes
      
      ui = %Ui{cursor: 0, auto_depth: 1000, overrides: %{}}
      component = build_span_tree(forest, ui)
      
      # Warmup
      for _ <- 1..3, do: HeadlessHarness.render(harness, component)
      
      {time, _} = :timer.tc(fn ->
        HeadlessHarness.render(harness, component)
      end)
      
      assert time < 100_000, "Render took #{time}μs, expected < 100ms"
      
      # Verify output is reasonable
      content = HeadlessHarness.text_content(harness)
      lines = String.split(content, "\n")
      assert length(lines) == 40  # Full height used
    end

    @tag :benchmark
    test "cursor movement stays responsive with large forests", %{harness: harness} do
      forest = DSLGenerators.generate_forest(20, 4, 5)  # ~2000 nodes
      ui = %Ui{cursor: 0, auto_depth: 1000, overrides: %{}}
      
      # Measure 100 cursor moves
      {time, final_ui} = :timer.tc(fn ->
        Enum.reduce(1..100, ui, fn i, acc_ui ->
          # Alternate up and down
          direction = if rem(i, 2) == 0, do: 1, else: -1
          Ui.cursor(acc_ui, direction)
        end)
      end)
      
      assert time < 10_000, "100 cursor moves took #{time}μs, expected < 10ms"
      assert final_ui.cursor >= 0
    end

    @tag :benchmark
    test "expand/collapse operations are fast", %{harness: harness} do
      forest = DSLGenerators.generate_forest(5, 10, 2)  # Deep but narrow
      ui = %Ui{cursor: 0, auto_depth: 1, overrides: %{}}
      
      root_ids = forest |> Map.values() |> Enum.filter(&(&1.parent_id == nil)) |> Enum.map(& &1.id)
      
      # Measure collapse all roots
      {collapse_time, collapsed_ui} = :timer.tc(fn ->
        Enum.reduce(root_ids, ui, fn id, acc ->
          Ui.collapse(acc, id)
        end)
      end)
      
      assert collapse_time < 5_000, "Collapse took #{collapse_time}μs"
      
      # Measure expand all roots
      {expand_time, _expanded_ui} = :timer.tc(fn ->
        Enum.reduce(root_ids, collapsed_ui, fn id, acc ->
          Ui.expand(acc, id)
        end)
      end)
      
      assert expand_time < 5_000, "Expand took #{expand_time}μs"
    end
  end

  @tag :benchmark
  describe "Memory Usage" do
    @tag :benchmark
    test "tool registry memory stays bounded" do
      initial_memory = :erlang.memory(:total)
      
      # Define 1000 tools
      for i <- 1..1000 do
        Tools.define_tool(%{
          "name" => "memory-test-#{i}",
          "params" => [:a, :b, :c],
          "source" => "(+ data/a data/b data/c)",
          "doc" => String.duplicate("x", 100)  # 100 char docs
        })
      end
      
      after_tools_memory = :erlang.memory(:total)
      memory_used = (after_tools_memory - initial_memory) / 1024 / 1024
      
      # Should use less than 10MB for 1000 tools
      assert memory_used < 10, "Used #{memory_used}MB for 1000 tools"
    end

    @tag :benchmark
    test "store memory usage is efficient" do
      {:ok, store} = Store.start_link(name: nil)
      initial_memory = :erlang.memory(:total)
      
      # Generate 10k spans
      for i <- 1..10_000 do
        :telemetry.execute(
          [:ptc_runner, :sub_agent, :tool, :start],
          %{},
          %{
            span_id: "span-#{i}",
            parent_span_id: if(i > 1, do: "span-#{:rand.uniform(i-1)}", else: nil),
            tool_name: "tool-#{i}",
            args: %{data: String.duplicate("x", 100)}
          }
        )
      end
      
      Process.sleep(200)
      
      after_spans_memory = :erlang.memory(:total)
      memory_used = (after_spans_memory - initial_memory) / 1024 / 1024
      
      # Should use less than 50MB for 10k spans
      assert memory_used < 50, "Used #{memory_used}MB for 10k spans"
      
      GenServer.stop(store)
    end
  end

  # Helper to build a SpanTree component
  defp build_span_tree(forest, ui) do
    %{
      __struct__: SpellAgent.Tui.Panes.SpanTree,
      spans: forest,
      ui: ui
    }
  end

  # Generate a large forest for testing
  defp generate_forest(size) do
    DSLGenerators.generate_forest(
      div(size, 100),  # roots
      5,               # depth
      10               # width
    )
  end
end