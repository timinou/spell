defmodule Mix.Tasks.VisualTestBrowser do
  @moduledoc """
  Interactive browser for visual test outputs and snapshots.
  
  Usage:
    mix visual_test_browser [options]
    
  Options:
    --port       Port to run the browser on (default: 4444)
    --baseline   Show baseline snapshots
    --diffs      Show visual regression diffs
    --live       Live render components
  """

  use Mix.Task
  
  alias ExRatatui.{App, Runtime, Layout.Rect}
  alias ExRatatui.Widgets.{Block, List, Paragraph, Tabs}
  alias ExRatatui.Event.Key
  alias SpellAgent.Test.HeadlessHarness
  
  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, 
      switches: [
        port: :integer,
        baseline: :boolean,
        diffs: :boolean,
        live: :boolean
      ]
    )
    
    Application.ensure_all_started(:ex_ratatui)
    Application.ensure_all_started(:spell_agent)
    
    # Start the visual test browser app
    {:ok, _pid} = VisualTestBrowser.App.start_link(opts)
    
    Mix.shell().info("Visual Test Browser started. Press 'q' to quit.")
    
    # Keep the task running
    Process.sleep(:infinity)
  end
end

defmodule VisualTestBrowser.App do
  @moduledoc """
  ExRatatui app for browsing visual test outputs.
  """
  
  use ExRatatui.App
  
  alias ExRatatui.{Widgets, Layout}
  alias SpellAgent.Test.HeadlessHarness
  
  defmodule State do
    defstruct [
      :mode,           # :list | :view | :compare
      :selected_idx,   # Currently selected item
      :items,          # List of test snapshots/components
      :current_view,   # Current snapshot being viewed
      :filter,         # Filter string
      :show_baseline,  # Show baseline snapshots
      :show_diffs,     # Show diff outputs
      :show_live,      # Show live components
      :comparison,     # Side-by-side comparison
      :terminal,       # Embedded terminal for live rendering
      :zoom_level,     # Zoom level for viewing
      :overlay_diff    # Overlay diff on baseline
    ]
  end
  
  @impl true
  def mount(opts) do
    state = %State{
      mode: :list,
      selected_idx: 0,
      items: load_items(opts),
      show_baseline: Keyword.get(opts, :baseline, true),
      show_diffs: Keyword.get(opts, :diffs, true),
      show_live: Keyword.get(opts, :live, false),
      zoom_level: 1.0
    }
    
    {:ok, state}
  end
  
  @impl true
  def handle_event(%Key{code: "q"}, state) do
    {:halt, state}
  end
  
  def handle_event(%Key{code: "escape"}, state) do
    # Return to list view
    {:noreply, %{state | mode: :list, current_view: nil}}
  end
  
  def handle_event(%Key{code: "enter"}, %{mode: :list} = state) do
    # View selected item
    item = Enum.at(state.items, state.selected_idx)
    
    case item do
      nil -> 
        {:noreply, state}
        
      %{type: :snapshot, path: path} ->
        view = load_snapshot(path)
        {:noreply, %{state | mode: :view, current_view: view}}
        
      %{type: :component, module: module} ->
        view = render_component(module)
        {:noreply, %{state | mode: :view, current_view: view}}
        
      %{type: :diff, baseline: base, current: curr} ->
        comparison = load_comparison(base, curr)
        {:noreply, %{state | mode: :compare, comparison: comparison}}
    end
  end
  
  def handle_event(%Key{code: "up"}, %{mode: :list} = state) do
    new_idx = max(0, state.selected_idx - 1)
    {:noreply, %{state | selected_idx: new_idx}}
  end
  
  def handle_event(%Key{code: "down"}, %{mode: :list} = state) do
    new_idx = min(length(state.items) - 1, state.selected_idx + 1)
    {:noreply, %{state | selected_idx: new_idx}}
  end
  
  def handle_event(%Key{code: "tab"}, %{mode: :compare} = state) do
    # Toggle between baseline/current/overlay in compare mode
    {:noreply, toggle_comparison_view(state)}
  end
  
  def handle_event(%Key{code: "+"}, state) do
    # Zoom in
    {:noreply, %{state | zoom_level: min(3.0, state.zoom_level + 0.1)}}
  end
  
  def handle_event(%Key{code: "-"}, state) do
    # Zoom out
    {:noreply, %{state | zoom_level: max(0.5, state.zoom_level - 0.1)}}
  end
  
  def handle_event(%Key{code: "/"}, state) do
    # Start filtering
    {:noreply, %{state | filter: ""}}
  end
  
  def handle_event(%Key{code: "r"}, state) do
    # Refresh/reload items
    {:noreply, %{state | items: load_items([])}}
  end
  
  def handle_event(%Key{code: "s"}, %{mode: :view} = state) do
    # Save current view as new baseline
    save_as_baseline(state.current_view)
    {:noreply, state}
  end
  
  def handle_event(%Key{code: "d"}, %{mode: :compare} = state) do
    # Show diff details
    {:noreply, %{state | overlay_diff: !state.overlay_diff}}
  end
  
  def handle_event(_event, state) do
    {:noreply, state}
  end
  
  @impl true
  def render(state, frame) do
    case state.mode do
      :list -> render_list_view(state, frame)
      :view -> render_single_view(state, frame)
      :compare -> render_comparison_view(state, frame)
    end
  end
  
  defp render_list_view(state, frame) do
    items = state.items
    |> filter_items(state.filter)
    |> Enum.map(&format_item/1)
    
    [
      {render_header(state), header_rect(frame)},
      {render_list(items, state.selected_idx), list_rect(frame)},
      {render_help_bar(:list), help_rect(frame)}
    ]
  end
  
  defp render_single_view(state, frame) do
    [
      {render_header(state), header_rect(frame)},
      {render_snapshot(state.current_view, state.zoom_level), view_rect(frame)},
      {render_metadata(state.current_view), metadata_rect(frame)},
      {render_help_bar(:view), help_rect(frame)}
    ]
  end
  
  defp render_comparison_view(state, frame) do
    [
      {render_header(state), header_rect(frame)},
      {render_baseline(state.comparison.baseline), left_rect(frame)},
      {render_current(state.comparison.current), right_rect(frame)},
      {render_diff_overlay(state), overlay_rect(frame)},
      {render_help_bar(:compare), help_rect(frame)}
    ]
  end
  
  defp render_header(state) do
    title = case state.mode do
      :list -> "Visual Test Browser"
      :view -> "Viewing: #{state.current_view.name}"
      :compare -> "Comparing: #{state.comparison.name}"
    end
    
    %Widgets.Block{
      title: title,
      borders: [:bottom],
      border_style: %{fg: :cyan}
    }
  end
  
  defp render_list(items, selected_idx) do
    %Widgets.List{
      items: items,
      selected: selected_idx,
      highlight_style: %{fg: :black, bg: :cyan},
      highlight_symbol: "▶ "
    }
  end
  
  defp render_help_bar(mode) do
    text = case mode do
      :list -> "[↑↓] Navigate  [Enter] View  [/] Filter  [r] Refresh  [q] Quit"
      :view -> "[s] Save as baseline  [+/-] Zoom  [Esc] Back  [q] Quit"
      :compare -> "[Tab] Toggle view  [d] Overlay diff  [Esc] Back  [q] Quit"
    end
    
    %Widgets.Paragraph{
      text: text,
      alignment: :center,
      style: %{fg: :dark_gray}
    }
  end
  
  defp render_snapshot(snapshot, zoom_level) do
    # Render the snapshot with zoom
    cells = apply_zoom(snapshot.cells, zoom_level)
    
    %Widgets.Paragraph{
      text: cells_to_text(cells),
      wrap: false
    }
  end
  
  defp render_metadata(snapshot) do
    metadata = """
    Name: #{snapshot.name}
    Dimensions: #{snapshot.width}x#{snapshot.height}
    Cells: #{length(snapshot.cells)}
    Created: #{snapshot.timestamp}
    """
    
    %Widgets.Paragraph{
      text: metadata,
      block: %Widgets.Block{
        title: " Metadata ",
        borders: [:all]
      }
    }
  end
  
  defp render_diff_overlay(%{overlay_diff: true, comparison: comp}) do
    diff = calculate_diff(comp.baseline, comp.current)
    
    %Widgets.Paragraph{
      text: format_diff(diff),
      style: %{fg: :red}
    }
  end
  defp render_diff_overlay(_), do: %Widgets.Paragraph{text: ""}
  
  # Helper functions
  
  defp load_items(opts) do
    items = []
    
    # Load baseline snapshots
    if Keyword.get(opts, :baseline, true) do
      baseline_items = load_baseline_snapshots()
      items = items ++ baseline_items
    end
    
    # Load diff outputs
    if Keyword.get(opts, :diffs, true) do
      diff_items = load_diff_outputs()
      items = items ++ diff_items
    end
    
    # Load live components
    if Keyword.get(opts, :live, false) do
      component_items = load_live_components()
      items = items ++ component_items
    end
    
    items
  end
  
  defp load_baseline_snapshots do
    path = Path.join(["test", "visual", "baseline"])
    
    if File.exists?(path) do
      Path.wildcard(Path.join(path, "*.snapshot"))
      |> Enum.map(fn file ->
        %{
          type: :snapshot,
          name: Path.basename(file, ".snapshot"),
          path: file
        }
      end)
    else
      []
    end
  end
  
  defp load_diff_outputs do
    path = Path.join(["test", "visual", "diff"])
    
    if File.exists?(path) do
      Path.wildcard(Path.join(path, "*.diff"))
      |> Enum.map(fn file ->
        name = Path.basename(file, ".diff")
        baseline_path = Path.join(["test", "visual", "baseline", "#{name}.snapshot"])
        
        %{
          type: :diff,
          name: name,
          baseline: baseline_path,
          current: file
        }
      end)
    else
      []
    end
  end
  
  defp load_live_components do
    # Load available test components
    [
      %{type: :component, name: "SpanTree (Empty)", module: SpellAgent.Tui.Panes.SpanTree},
      %{type: :component, name: "SpanTree (Populated)", module: SpellAgent.Tui.Panes.SpanTree},
      %{type: :component, name: "Dashboard", module: SpellAgent.Tui.Panes.Dashboard},
      %{type: :component, name: "Prompt Input", module: SpellAgent.Tui.Panes.PromptInput}
    ]
  end
  
  defp load_snapshot(path) do
    binary = File.read!(path)
    cells = :erlang.binary_to_term(binary)
    
    %{
      name: Path.basename(path, ".snapshot"),
      cells: cells,
      width: detect_width(cells),
      height: detect_height(cells),
      timestamp: File.stat!(path).mtime
    }
  end
  
  defp render_component(module) do
    # Create a headless harness and render the component
    harness = HeadlessHarness.new()
    
    # Create test instance of component
    component = case module do
      SpellAgent.Tui.Panes.SpanTree ->
        # Generate test data
        %{__struct__: module, spans: test_forest(), ui: %{cursor: 0}}
        
      _ ->
        # Default instance
        struct(module)
    end
    
    HeadlessHarness.render(harness, component)
    snapshot = HeadlessHarness.snapshot(harness)
    
    %{
      name: inspect(module),
      cells: snapshot,
      width: harness.width,
      height: harness.height,
      timestamp: DateTime.utc_now()
    }
  end
  
  defp test_forest do
    # Generate test data for components
    %{
      "root-1" => %{id: "root-1", parent_id: nil, kind: :run, status: :ok},
      "tool-1" => %{id: "tool-1", parent_id: "root-1", kind: :tool, status: :ok},
      "tool-2" => %{id: "tool-2", parent_id: "root-1", kind: :tool, status: :error}
    }
  end
  
  defp filter_items(items, nil), do: items
  defp filter_items(items, ""), do: items
  defp filter_items(items, filter) do
    Enum.filter(items, fn item ->
      String.contains?(String.downcase(item.name), String.downcase(filter))
    end)
  end
  
  defp format_item(%{type: :snapshot, name: name}) do
    "📸 #{name}"
  end
  defp format_item(%{type: :diff, name: name}) do
    "🔴 #{name} (diff)"
  end
  defp format_item(%{type: :component, name: name}) do
    "🎨 #{name} (live)"
  end
  
  defp cells_to_text(cells) do
    cells
    |> Enum.group_by(& &1.y)
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.map(fn {_y, row_cells} ->
      row_cells
      |> Enum.sort_by(& &1.x)
      |> Enum.map(& &1.symbol)
      |> Enum.join()
    end)
    |> Enum.join("\n")
  end
  
  defp apply_zoom(cells, zoom_level) when zoom_level == 1.0, do: cells
  defp apply_zoom(cells, zoom_level) do
    # Simple zoom by scaling coordinates
    Enum.map(cells, fn cell ->
      %{cell | 
        x: round(cell.x * zoom_level),
        y: round(cell.y * zoom_level)
      }
    end)
  end
  
  defp detect_width(cells) do
    cells |> Enum.map(& &1.x) |> Enum.max(fn -> 80 end)
  end
  
  defp detect_height(cells) do
    cells |> Enum.map(& &1.y) |> Enum.max(fn -> 24 end)
  end
  
  # Layout helpers
  
  defp header_rect(frame) do
    %Rect{x: 0, y: 0, width: frame.width, height: 3}
  end
  
  defp list_rect(frame) do
    %Rect{x: 0, y: 3, width: frame.width, height: frame.height - 4}
  end
  
  defp view_rect(frame) do
    %Rect{x: 0, y: 3, width: frame.width, height: frame.height - 10}
  end
  
  defp metadata_rect(frame) do
    %Rect{x: 0, y: frame.height - 7, width: frame.width, height: 6}
  end
  
  defp help_rect(frame) do
    %Rect{x: 0, y: frame.height - 1, width: frame.width, height: 1}
  end
  
  defp left_rect(frame) do
    %Rect{x: 0, y: 3, width: div(frame.width, 2), height: frame.height - 4}
  end
  
  defp right_rect(frame) do
    %Rect{
      x: div(frame.width, 2),
      y: 3,
      width: div(frame.width, 2),
      height: frame.height - 4
    }
  end
  
  defp overlay_rect(frame) do
    %Rect{x: 0, y: 3, width: frame.width, height: frame.height - 4}
  end
  
  defp render_baseline(baseline) do
    %Widgets.Paragraph{
      text: cells_to_text(baseline.cells),
      block: %Widgets.Block{
        title: " Baseline ",
        borders: [:all],
        border_style: %{fg: :green}
      }
    }
  end
  
  defp render_current(current) do
    %Widgets.Paragraph{
      text: cells_to_text(current.cells),
      block: %Widgets.Block{
        title: " Current ",
        borders: [:all],
        border_style: %{fg: :yellow}
      }
    }
  end
  
  defp load_comparison(baseline_path, current_path) do
    %{
      name: Path.basename(baseline_path, ".snapshot"),
      baseline: load_snapshot(baseline_path),
      current: load_snapshot(current_path)
    }
  end
  
  defp toggle_comparison_view(state) do
    # Cycle through views in compare mode
    state
  end
  
  defp calculate_diff(baseline, current) do
    # Calculate cell-by-cell differences
    baseline_map = Map.new(baseline.cells, &{{&1.x, &1.y}, &1})
    current_map = Map.new(current.cells, &{{&1.x, &1.y}, &1})
    
    all_positions = MapSet.union(
      MapSet.new(Map.keys(baseline_map)),
      MapSet.new(Map.keys(current_map))
    )
    
    Enum.map(all_positions, fn pos ->
      base_cell = Map.get(baseline_map, pos)
      curr_cell = Map.get(current_map, pos)
      
      cond do
        base_cell == nil -> {:added, curr_cell}
        curr_cell == nil -> {:removed, base_cell}
        base_cell != curr_cell -> {:changed, base_cell, curr_cell}
        true -> {:same, base_cell}
      end
    end)
  end
  
  defp format_diff(diff) do
    diff
    |> Enum.filter(fn
      {:same, _} -> false
      _ -> true
    end)
    |> Enum.map(fn
      {:added, cell} -> "+ (#{cell.x},#{cell.y}): #{cell.symbol}"
      {:removed, cell} -> "- (#{cell.x},#{cell.y}): #{cell.symbol}"
      {:changed, old, new} -> "~ (#{old.x},#{old.y}): #{old.symbol} → #{new.symbol}"
    end)
    |> Enum.join("\n")
  end
  
  defp save_as_baseline(view) do
    path = Path.join(["test", "visual", "baseline", "#{view.name}.snapshot"])
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, :erlang.term_to_binary(view.cells))
    IO.puts("Saved as baseline: #{path}")
  end
end