defmodule SpellAgent.Tui.SceneRender do
  @moduledoc """
  The ONE render path shared by every visual consumer of a gallery scene
  (PLAN-347): the interactive `ScreenGallery`, the snapshot baseline writer, the
  snapshot regression test, and the render performance benchmark all go through
  here, so what a human sees, what gets committed as a baseline, and what the
  perf test measures are byte-for-byte the same pixels.

  A scene (`SpellAgent.Tui.Scenes`) is `%{name, about, forest}`. We project its
  forest through the PRODUCTION `SpanTree.project/2` + `view/1` and materialize
  the descriptor into the SAME `ExRatatui.Widgets.List` the inspector `App`
  builds — duplicating none of that logic, just reusing it.

  Two outputs:

    * `widget/3` — the `%List{}` struct, for an `ExRatatui.App` to place in a rect
      (the interactive gallery), and
    * `buffer/2` — the scene rendered to a headless test terminal and read back as
      a trimmed multi-line string (the snapshot baseline + regression target).

  `buffer/2` is pure-ish: it spins up a throwaway `init_test_terminal`, draws one
  frame, reads the buffer, and restores the terminal — no global state, safe to
  call concurrently from `async: true` tests.
  """

  alias ExRatatui.Layout.Rect
  alias ExRatatui.Style
  alias ExRatatui.Widgets.{Block, List}
  alias SpellAgent.Tui.Ui
  alias SpellAgent.Tui.Panes.SpanTree

  @default_width 80
  @default_height 24

  @doc """
  The scene's span tree as an `ExRatatui` `%List{}` widget, projected under
  `gaze` (a `Ui.t()`) and titled with the live row count. `focused?` toggles the
  cursor highlight exactly as the inspector does.
  """
  @spec widget(map(), Ui.t(), keyword()) :: List.t()
  def widget(scene, %Ui{} = gaze, opts \\ []) do
    focused? = Keyword.get(opts, :focused?, true)
    rect = Keyword.get(opts, :rect, full_rect())

    vm = SpanTree.project(scene.forest, %{ui: gaze})
    assigns = %{ui: gaze, cursor: Ui.cursor_of(gaze, :tree)}

    [{{:list, desc}, _rect}] =
      SpanTree.view(%{vm: vm, rect: rect, assigns: assigns, focused?: focused?})

    items =
      Enum.map(desc.lines, fn line ->
        %ExRatatui.Text.Line{
          spans: [%ExRatatui.Text.Span{content: line.text, style: %Style{fg: status_color(line.status)}}]
        }
      end)

    %List{
      items: items,
      block: %Block{title: " #{desc.title} ", borders: [:all], border_type: :rounded},
      highlight_style: %Style{modifiers: [:bold]},
      selected: select_index(desc, length(items))
    }
  end

  @doc """
  Render `scene` to a headless test terminal and return the trimmed buffer as a
  string — the canonical snapshot form. `:width`/`:height`/`:gaze` override the
  defaults (a fresh fully-expanded gaze at cursor 0).

  Always restores the terminal, even if `draw/2` fails, so a throwing scene can
  never leak a terminal resource.
  """
  @spec buffer(map(), keyword()) :: String.t()
  def buffer(scene, opts \\ []) do
    width = Keyword.get(opts, :width, @default_width)
    height = Keyword.get(opts, :height, @default_height)
    gaze = Keyword.get(opts, :gaze, default_gaze())

    rect = %Rect{x: 0, y: 0, width: width, height: height}
    terminal = ExRatatui.init_test_terminal(width, height)

    try do
      :ok = ExRatatui.draw(terminal, [{widget(scene, gaze, rect: rect), rect}])
      ExRatatui.get_buffer_content(terminal)
    after
      ExRatatui.Native.restore_terminal(terminal)
    end
  end

  @doc """
  A fresh gaze focused on the tree, FULLY EXPANDED (every node's children shown),
  cursor at the top. `auto_depth: 1_000_000` is the "show everything" sentinel
  `SpanTree` honours — snapshots want the whole tree, not the inspector's default
  depth-1 collapse.
  """
  @spec default_gaze() :: Ui.t()
  def default_gaze, do: Ui.new(focus: :tree, panes: [:tree], auto_depth: 1_000_000)

  @doc "The default full-screen rect used when a caller does not supply one."
  @spec full_rect() :: Rect.t()
  def full_rect, do: %Rect{x: 0, y: 0, width: @default_width, height: @default_height}

  defp select_index(_desc, 0), do: nil
  defp select_index(%{focused?: true, cursor: c}, count), do: c |> max(0) |> min(count - 1)
  defp select_index(_desc, _count), do: nil

  defp status_color(:ok), do: :green
  defp status_color(:error), do: :red
  defp status_color(_), do: :yellow
end