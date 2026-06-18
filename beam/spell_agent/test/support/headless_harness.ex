defmodule SpellAgent.Test.HeadlessHarness do
  @moduledoc """
  Visual testing harness for spell_agent TUI components.
  Renders to headless terminal, captures output for assertions.
  
  Based on ex_ratatui patterns but tailored for spell_agent specifics.
  """

  alias ExRatatui.{CellSession, Layout.Rect}
  alias ExRatatui.Widgets.Block
  
  defstruct [:session, :width, :height, :store]

  @doc "Create a new headless terminal harness"
  def new(opts \\ []) do
    width = Keyword.get(opts, :width, 80)
    height = Keyword.get(opts, :height, 24)
    with_store = Keyword.get(opts, :with_store, true)
    
    session = CellSession.new(width, height)
    
    store = if with_store do
      {:ok, pid} = SpellAgent.Tui.Store.start_link(name: nil)
      pid
    else
      nil
    end
    
    %__MODULE__{
      session: session,
      width: width,
      height: height,
      store: store
    }
  end

  @doc "Render a component to the headless terminal"
  def render(%__MODULE__{} = h, component) do
    rect = %Rect{x: 0, y: 0, width: h.width, height: h.height}
    :ok = CellSession.draw(h.session, [{component, rect}])
    h
  end

  @doc "Get the text content of the terminal as a string"
  def text_content(%__MODULE__{session: session}) do
    %{cells: cells} = CellSession.take_cells(session)
    
    cells
    |> Enum.group_by(& &1.y)
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.map(fn {_y, row_cells} ->
      row_cells
      |> Enum.sort_by(& &1.x)
      |> Enum.map(& &1.symbol)
      |> Enum.join()
      |> String.trim_trailing()
    end)
    |> Enum.join("\n")
  end

  @doc "Get cells as a 2D map for precise inspection"
  def cells_map(%__MODULE__{session: session}) do
    %{cells: cells} = CellSession.take_cells(session)
    
    Map.new(cells, fn cell ->
      {{cell.x, cell.y}, cell}
    end)
  end

  @doc "Assert text appears anywhere in the terminal"
  def assert_text(%__MODULE__{} = h, pattern) when is_binary(pattern) do
    content = text_content(h)
    
    unless content =~ pattern do
      raise ExUnit.AssertionError,
        message: "Expected to find #{inspect(pattern)} in terminal",
        expr: pattern,
        context: content
    end
    
    h
  end

  def assert_text(%__MODULE__{} = h, pattern) when is_struct(pattern, Regex) do
    content = text_content(h)
    
    unless Regex.match?(pattern, content) do
      raise ExUnit.AssertionError,
        message: "Expected pattern #{inspect(pattern)} to match",
        context: content
    end
    
    h
  end

  @doc "Assert text does NOT appear"
  def refute_text(%__MODULE__{} = h, pattern) do
    content = text_content(h)
    
    if content =~ pattern do
      raise ExUnit.AssertionError,
        message: "Did not expect to find #{inspect(pattern)}",
        context: content
    end
    
    h
  end

  @doc "Assert style at specific coordinates"
  def assert_style_at(%__MODULE__{} = h, x, y, expected) do
    cells = cells_map(h)
    cell = Map.get(cells, {x, y})
    
    unless cell do
      raise ExUnit.AssertionError,
        message: "No cell at position (#{x}, #{y})"
    end
    
    for {attr, expected_value} <- expected do
      actual_value = Map.get(cell, attr)
      
      unless actual_value == expected_value do
        raise ExUnit.AssertionError,
          message: "Style mismatch at (#{x}, #{y})",
          left: {attr, expected_value},
          right: {attr, actual_value}
      end
    end
    
    h
  end

  @doc "Assert a specific line contains text"
  def assert_line(%__MODULE__{} = h, line_num, pattern) do
    lines = text_content(h) |> String.split("\n")
    line = Enum.at(lines, line_num, "")
    
    unless line =~ pattern do
      raise ExUnit.AssertionError,
        message: "Line #{line_num} doesn't match",
        expr: pattern,
        context: line
    end
    
    h
  end

  @doc "Get a specific row of text"
  def row_text(%__MODULE__{} = h, row) do
    text_content(h)
    |> String.split("\n")
    |> Enum.at(row, "")
  end

  @doc "Count occurrences of a pattern"
  def count_matches(%__MODULE__{} = h, pattern) do
    text_content(h)
    |> String.split("\n")
    |> Enum.count(&(&1 =~ pattern))
  end

  @doc "Take a snapshot for visual regression testing"
  def snapshot(%__MODULE__{session: session}) do
    %{cells: cells} = CellSession.take_cells(session)
    
    # Serialize to a stable format
    cells
    |> Enum.map(&Map.take(&1, [:x, :y, :symbol, :fg, :bg, :modifiers]))
    |> Enum.sort_by(&{&1.y, &1.x})
  end

  @doc "Compare against a baseline snapshot"
  def assert_snapshot(%__MODULE__{} = h, baseline_name) do
    current = snapshot(h)
    baseline_path = Path.join(["test", "visual", "baseline", "#{baseline_name}.snapshot"])
    
    if File.exists?(baseline_path) do
      baseline = baseline_path |> File.read!() |> :erlang.binary_to_term()
      
      if current != baseline do
        diff_path = Path.join(["test", "visual", "diff", "#{baseline_name}.diff"])
        File.mkdir_p!(Path.dirname(diff_path))
        File.write!(diff_path, inspect(current, pretty: true))
        
        raise ExUnit.AssertionError,
          message: "Visual regression detected for #{baseline_name}",
          expr: "Check diff at: #{diff_path}"
      end
    else
      # Create new baseline
      File.mkdir_p!(Path.dirname(baseline_path))
      File.write!(baseline_path, :erlang.term_to_binary(current))
      IO.puts("Created new baseline: #{baseline_name}")
    end
    
    h
  end

  @doc "Clean up the harness"
  def cleanup(%__MODULE__{store: nil}), do: :ok
  def cleanup(%__MODULE__{store: store}) do
    if Process.alive?(store), do: GenServer.stop(store)
    :ok
  end
end