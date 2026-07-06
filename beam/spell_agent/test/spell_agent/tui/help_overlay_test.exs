defmodule SpellAgent.Tui.HelpOverlayTest do
  @moduledoc """
  FEAT-047: the help overlay (`?` / C-g) — a centered cheat-sheet of every live
  binding, derived from `data/keybindings` via the proven cells-drawer overlay
  discipline. These tests drive the REAL `App.render/2` placement pipeline (not a
  private helper) so they defend the observable contract: the overlay appears iff
  `ui.flags["help"]` is set, lists the reflected bindings, and never bricks the
  frame on malformed data.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{App, KeymapIntrospect, Store, Ui}
  alias ExRatatui.Widgets.List, as: WList
  alias ExRatatui.Frame

  setup do
    {:ok, store} = Store.start_link(name: nil)
    %{store: store}
  end

  defp state(store, overrides) do
    Map.merge(
      %{
        store: store,
        panes: [
          %{name: :tree, module: SpellAgent.Tui.Panes.SpanTree, assigns: %{}},
          %{name: :detail, module: SpellAgent.Tui.Panes.Detail, assigns: %{}}
        ],
        vms: %{tree: %{rows: [], count: 0}, detail: %{title: "detail", body: "(empty)"}},
        composer: "",
        on_submit: fn _ -> :ok end,
        running?: false,
        result: nil,
        last_prompt: nil,
        pending_leader: false,
        ui: Ui.new(focus: :tree, panes: [:prompt, :tree, :detail]),
        palette: SpellAgent.Tui.Palette.new()
      },
      overrides
    )
  end

  # The overlay is a List widget whose block title carries "keys".
  defp help_widget(placements) do
    Enum.find(placements, fn
      {%WList{block: %{title: t}}, _rect} when is_binary(t) -> t =~ "keys"
      _ -> false
    end)
  end

  defp flag(ui, key, val), do: %{ui | flags: Map.put(ui.flags, key, val)}

  test "the overlay is ABSENT when the help flag is unset", %{store: store} do
    placements = App.render(state(store, %{}), %Frame{width: 80, height: 30})
    refute help_widget(placements)
  end

  test "the overlay APPEARS and lists reflected bindings when help is set", %{store: store} do
    ui = flag(Ui.new(focus: :tree, panes: [:prompt, :tree, :detail]), "help", true)

    st =
      state(store, %{
        ui: ui,
        data_sources: %{"keybindings" => KeymapIntrospect.rows()}
      })

    placements = App.render(st, %Frame{width: 100, height: 40})
    assert {%WList{items: items}, _rect} = help_widget(placements)

    # Grouped by context, with a global header and the cockpit chord.
    text = Enum.join(items, "\n")
    assert text =~ "global"
    assert text =~ "C-o"
    assert text =~ "cockpit"
  end

  test "malformed keybindings data NEVER bricks the frame", %{store: store} do
    ui = flag(Ui.new(focus: :tree, panes: [:prompt, :tree, :detail]), "help", true)

    for bad <- [%{"keybindings" => "not-a-list"}, %{"keybindings" => [%{}, 42]}, %{"keybindings" => nil}] do
      st = state(store, %{ui: ui, data_sources: bad})
      # Must render (the rest of the frame survives), never raise.
      placements = App.render(st, %Frame{width: 80, height: 30})
      assert is_list(placements)
      assert length(placements) > 0
    end
  end

  test "an empty keybinding set shows the placeholder, not a crash", %{store: store} do
    ui = flag(Ui.new(focus: :tree, panes: [:prompt, :tree, :detail]), "help", true)
    st = state(store, %{ui: ui, data_sources: %{"keybindings" => []}})

    placements = App.render(st, %Frame{width: 80, height: 30})
    assert {%WList{items: items}, _} = help_widget(placements)
    assert Enum.join(items, "\n") =~ "no keybindings"
  end
end
