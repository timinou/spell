defmodule Mix.Tasks.VisualTestBrowser do
  @moduledoc """
  Interactive browser for visual test outputs and snapshots.
  
  Usage:
    mix visual_test_browser
  """

  use Mix.Task
  
  @impl Mix.Task
  def run(_args) do
    Application.ensure_all_started(:ex_ratatui)
    Application.ensure_all_started(:spell_agent)
    
    # Start the test browser
    {:ok, _pid} = VisualBrowser.start()
    
    Mix.shell().info("Visual Test Browser started. Press 'q' to quit.")
    
    # Keep running
    Process.sleep(:infinity)
  end
end

defmodule VisualBrowser do
  @moduledoc """
  Simple visual test browser using ExRatatui.
  """
  
  use GenServer
  
  alias ExRatatui.{App, Runtime}
  alias ExRatatui.Widgets.{Paragraph, Block, List}
  alias SpellAgent.Test.HeadlessHarness
  
  def start do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end
  
  @impl GenServer
  def init(_) do
    # Start the ExRatatui app
    {:ok, app} = App.start_link(
      name: nil,
      runtime: [
        backend: :termion,
        quit_events: [
          %ExRatatui.Event.Key{code: "q", kind: "press"}
        ]
      ],
      app_module: __MODULE__
    )
    
    state = %{
      app: app,
      mode: :list,
      items: load_test_items(),
      selected: 0
    }
    
    {:ok, state}
  end
  
  # ExRatatui App callbacks
  def mount(_opts) do
    {:ok, %{
      mode: :list,
      items: load_test_items(),
      selected: 0
    }}
  end
  
  def handle_event(%ExRatatui.Event.Key{code: "q"}, state) do
    {:halt, state}
  end
  
  def handle_event(%ExRatatui.Event.Key{code: "up"}, state) do
    new_selected = max(0, state.selected - 1)
    {:noreply, %{state | selected: new_selected}}
  end
  
  def handle_event(%ExRatatui.Event.Key{code: "down"}, state) do
    new_selected = min(length(state.items) - 1, state.selected + 1)
    {:noreply, %{state | selected: new_selected}}
  end
  
  def handle_event(%ExRatatui.Event.Key{code: "enter"}, state) do
    item = Enum.at(state.items, state.selected)
    
    case item do
      %{type: :component, module: module} ->
        view = render_test_component(module)
        {:noreply, %{state | mode: :view, current_view: view}}
        
      _ ->
        {:noreply, state}
    end
  end
  
  def handle_event(%ExRatatui.Event.Key{code: "escape"}, state) do
    {:noreply, %{state | mode: :list, current_view: nil}}
  end
  
  def handle_event(_event, state) do
    {:noreply, state}
  end
  
  def render(state, _frame) do
    case state.mode do
      :list ->
        render_list_view(state)
        
      :view ->
        render_component_view(state)
        
      _ ->
        [%Paragraph{text: "Unknown mode"}]
    end
  end
  
  # Private helpers
  
  defp render_list_view(state) do
    items = state.items |> Enum.map(&format_item/1)
    
    [
      %Block{
        title: " Visual Test Browser ",
        borders: [:all],
        border_style: %{fg: :cyan}
      },
      %List{
        items: items,
        selected: state.selected,
        highlight_style: %{fg: :black, bg: :cyan}
      },
      %Paragraph{
        text: "[↑↓] Navigate  [Enter] View  [q] Quit",
        style: %{fg: :dark_gray}
      }
    ]
  end
  
  defp render_component_view(state) do
    [
      %Block{
        title: " Component View ",
        borders: [:all],
        border_style: %{fg: :green}
      },
      %Paragraph{
        text: state.current_view || "No view loaded",
        wrap: true
      },
      %Paragraph{
        text: "[Esc] Back  [q] Quit",
        style: %{fg: :dark_gray}
      }
    ]
  end
  
  defp load_test_items do
    # Load available test components
    [
      %{type: :component, name: "SpanTree", module: SpellAgent.Tui.Panes.SpanTree},
      %{type: :component, name: "Store", module: SpellAgent.Tui.Store},
      %{type: :snapshot, name: "baseline-1", path: "test/visual/baseline/test.snapshot"},
      %{type: :diff, name: "diff-1", path: "test/visual/diff/test.diff"}
    ]
  end
  
  defp format_item(%{type: :component, name: name}) do
    "🎨 #{name} (component)"
  end
  defp format_item(%{type: :snapshot, name: name}) do
    "📸 #{name} (snapshot)"
  end
  defp format_item(%{type: :diff, name: name}) do
    "🔴 #{name} (diff)"
  end
  defp format_item(%{name: name}) do
    "📄 #{name}"
  end
  
  defp render_test_component(module) do
    try do
      # Create a simple test instance
      harness = HeadlessHarness.new(width: 80, height: 24)
      
      component = case module do
        SpellAgent.Tui.Panes.SpanTree ->
          # Create test data
          test_spans = %{
            "root" => %{id: "root", parent_id: nil, kind: :run, status: :ok, label: "Test Run"},
            "t1" => %{id: "t1", parent_id: "root", kind: :tool, status: :ok, label: "Tool 1"},
            "t2" => %{id: "t2", parent_id: "root", kind: :tool, status: :error, label: "Tool 2"}
          }
          
          # Create a paragraph with the test data
          %ExRatatui.Widgets.Paragraph{
            text: """
            SpanTree Test:
            ▼ [run] Test Run ✓
              ├─ [tool] Tool 1 ✓
              └─ [tool] Tool 2 ✗
            """,
            wrap: true
          }
          
        _ ->
          %ExRatatui.Widgets.Paragraph{
            text: "Component: #{inspect(module)}",
            wrap: true
          }
      end
      
      # Render and capture
      HeadlessHarness.render(harness, component)
      text = HeadlessHarness.text_content(harness)
      HeadlessHarness.cleanup(harness)
      
      text
    rescue
      error ->
        "Error rendering component: #{inspect(error)}"
    end
  end
end