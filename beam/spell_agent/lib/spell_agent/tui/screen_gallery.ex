defmodule SpellAgent.Tui.ScreenGallery do
  @moduledoc """
  A bespoke gallery for browsing the inspector's screens by hand (PLAN-347).

  It is a real `ExRatatui.App` — the same runtime the live inspector uses — but
  instead of running a mission it cycles a curated list of FIXTURE forests
  through the production `SpanTree` projection + render path. So what you see is
  exactly what the inspector draws for that state, with zero network and zero
  agent loop.

  Left pane: the gallery index (pick a scene). Right pane: that scene rendered by
  `SpanTree.view/1`, materialized into the same `List` widget `App` builds. The
  footer shows the scene's description.

  Launch with `mix spell.gallery` (or `SpellAgent.Tui.ScreenGallery.start_link/1`
  from a real terminal). `j/k` or `↑/↓` move between scenes, `l/h` expand and
  collapse the cursor row inside a scene, `esc`/`q` quit.

  This is a DEV/inspection affordance, not part of the agent runtime — it exists
  so a human (or a visual-diff harness) can eyeball every tree state the pane can
  produce.
  """

  use ExRatatui.App

  alias ExRatatui.Layout
  alias ExRatatui.Layout.Rect
  alias ExRatatui.Style
  alias ExRatatui.Widgets.{Block, List, Paragraph}
  alias SpellAgent.Tui.{Scenes, SceneRender}
  alias SpellAgent.Tui.Panes.SpanTree

  # ---- mount ----

  @impl true
  def mount(opts) do
    scenes = opts[:scenes] || Scenes.all()

    {:ok,
     %{
       scenes: scenes,
       # Which scene in the index is selected.
       index: 0,
       # The gaze used to render the CURRENT scene's tree (cursor + collapse).
       # Focus :tree so cursor/expand reactions apply to the tree directly; fully
       # expanded (the SceneRender default) so a scene opens showing everything.
       ui: SceneRender.default_gaze()
     }}
  end

  # ---- render ----

  @impl true
  def render(state, frame) do
    area = %Rect{x: 0, y: 0, width: frame.width, height: frame.height}

    [header, body, footer] =
      Layout.split(area, :vertical, [{:length, 3}, {:min, 0}, {:length, 3}])

    [index_rect, scene_rect] =
      Layout.split(body, :horizontal, [{:percentage, 32}, {:percentage, 68}])

    [
      {header_widget(state), header},
      {index_widget(state), index_rect},
      {scene_widget(state, scene_rect), scene_rect},
      {footer_widget(state), footer}
    ]
  end

  # The gallery header: name + position in the set.
  defp header_widget(state) do
    n = length(state.scenes)
    pos = state.index + 1

    %Paragraph{
      text: "spell · screen gallery   (#{pos}/#{n})",
      style: %Style{fg: :cyan, modifiers: [:bold]},
      block: %Block{title: " gallery ", borders: [:all], border_type: :rounded}
    }
  end

  # Left index: one row per scene, the selected one highlighted by the List widget.
  defp index_widget(state) do
    items = Enum.map(state.scenes, fn scene -> scene.name end)

    %List{
      items: items,
      block: %Block{title: " scenes ", borders: [:all], border_type: :rounded},
      highlight_style: %Style{fg: :black, bg: :cyan, modifiers: [:bold]},
      selected: state.index
    }
  end

  # Right pane: the selected scene rendered through the ONE shared SceneRender
  # path — the SAME function the snapshot baselines and perf test use, so the
  # gallery is a faithful preview of what gets committed and measured.
  defp scene_widget(state, rect) do
    SceneRender.widget(current_scene(state), state.ui, rect: rect, focused?: true)
  end

  defp footer_widget(state) do
    scene = current_scene(state)

    %Paragraph{
      text: scene.about <> "      j/k move · l/h expand|collapse · esc quit",
      style: %Style{fg: :dark_gray},
      block: %Block{borders: [:all], border_type: :rounded}
    }
  end

  # ---- events ----

  @impl true
  def handle_event(%ExRatatui.Event.Key{code: code, kind: kind}, state)
      when kind in ["press", "repeat"] do
    handle_key(code, state)
  end

  def handle_event(_event, state), do: {:noreply, state}

  # Quit.
  defp handle_key(code, state) when code in ["q", "esc"], do: {:stop, state}

  # Move between scenes (resets the gaze so each scene opens fully expanded at row 0).
  defp handle_key(code, state) when code in ["down", "j"] do
    {:noreply, move(state, +1)}
  end

  defp handle_key(code, state) when code in ["up", "k"] do
    {:noreply, move(state, -1)}
  end

  # Move the cursor WITHIN the current scene's tree.
  defp handle_key(code, state) when code in ["right", "l"] do
    {:noreply, react(state, :"span/expand")}
  end

  defp handle_key(code, state) when code in ["left", "h"] do
    {:noreply, react(state, :"span/contract")}
  end

  # Cursor up/down inside the tree uses shift to distinguish from scene-nav? Keep
  # it simple: `n`/`p` move the in-tree cursor so expand/collapse has a target.
  defp handle_key("n", state), do: {:noreply, react(state, :"cursor/next")}
  defp handle_key("p", state), do: {:noreply, react(state, :"cursor/prev")}

  defp handle_key(_code, state), do: {:noreply, state}

  # ---- helpers ----

  defp current_scene(state), do: Enum.at(state.scenes, state.index)

  defp move(state, delta) do
    n = length(state.scenes)
    index = state.index |> Kernel.+(delta) |> rem(n) |> wrap(n)
    # Fresh gaze per scene: expanded, cursor at the top.
    %{state | index: index, ui: SceneRender.default_gaze()}
  end

  defp wrap(i, n) when i < 0, do: i + n
  defp wrap(i, _n), do: i

  # Apply a SpanTree reaction (cursor/expand/contract) to the gaze over the
  # current scene's forest — the SAME pure react/3 the inspector uses.
  defp react(state, intent) do
    forest = current_scene(state).forest
    ui = SpanTree.react(intent, state.ui, forest)
    %{state | ui: ui}
  end

end