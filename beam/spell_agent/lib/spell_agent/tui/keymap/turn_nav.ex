defmodule SpellAgent.Tui.Keymap.TurnNav do
  @moduledoc """
  The detail-pane focus context (PLAN-346 W5).

  When the DETAIL inspector is focused, the content can exceed the pane height, so
  the chords scroll it: `j`/`k` (and arrows) by a line, page keys by ten. The tree
  cursor (which selects WHAT the detail shows) is driven from the tree pane; here
  we only move WITHIN the shown content. `react/3` reads `ui.focus` so scroll
  targets the focused pane (the detail, normally).

  A CONTEXT, not a render pane: `keymap/0` + `react/3` + `context_name/0` only.
  Registry key stays `:turn_nav` for binding-override continuity.
  """

  use SpellAgent.Tui.Pane

  alias SpellAgent.Tui.Ui

  @doc "This context's registry key (for live `keymap/bind` overrides)."
  @spec context_name() :: :turn_nav
  def context_name, do: :turn_nav

  keymap([
    {"j", :"scroll/down"},
    {"k", :"scroll/up"},
    {"down", :"scroll/down"},
    {"up", :"scroll/up"},
    {"page_up", :"scroll/page-up"},
    {"page_down", :"scroll/page-down"}
  ])

  # A keymap context is not rendered; satisfy the Pane behaviour with a no-op view.
  @impl true
  def view(_), do: []

  @impl true
  # Scroll the FOCUSED pane's text — ui.focus tells us which (detail, normally).
  def react(:"scroll/up", %Ui{focus: f} = ui, _forest), do: Ui.scroll(ui, f, -1)
  def react(:"scroll/down", %Ui{focus: f} = ui, _forest), do: Ui.scroll(ui, f, +1)
  def react(:"scroll/page-up", %Ui{focus: f} = ui, _forest), do: Ui.scroll(ui, f, -10)
  def react(:"scroll/page-down", %Ui{focus: f} = ui, _forest), do: Ui.scroll(ui, f, +10)
  def react(_intent, %Ui{} = ui, _forest), do: ui
end
