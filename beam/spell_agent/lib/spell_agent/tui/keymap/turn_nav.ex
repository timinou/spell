defmodule SpellAgent.Tui.Keymap.TurnNav do
  @moduledoc """
  The answer/prompt focus context (PLAN-346) — the OTHER reading of `C-l`/`C-h`.

  This is the contextual-resolution payoff made concrete: when the result
  (answer) or prompt pane is focused, `C-l`/`C-h` navigate TURNS instead of
  expanding/collapsing a span (which is what they mean under tree focus, in
  `SpellAgent.Tui.Panes.SpanTree`). Same chords, different intent — selected by
  which context the App puts at the top of the resolver stack.

  Like `Keymap.Global` it is a CONTEXT, not a render pane: it supplies only
  `keymap/0` + `react/3` + `context_name/0`, the trio the resolver needs. Both the
  `:answer` and `:prompt` focuses resolve through this one context (they share the
  turn-navigation vocabulary); `react/3` reads `ui.focus` so `scroll/*` targets
  whichever of the two is actually focused.
  """

  use SpellAgent.Tui.Pane

  alias SpellAgent.Tui.Ui

  @doc "This context's registry key (for live `keymap/bind` overrides)."
  @spec context_name() :: :turn_nav
  def context_name, do: :turn_nav

  keymap([
    {"C-l", :"turn/next"},
    {"C-h", :"turn/prev"},
    {"up", :"scroll/up"},
    {"down", :"scroll/down"},
    {"page_up", :"scroll/page-up"},
    {"page_down", :"scroll/page-down"}
  ])

  # A keymap context is not rendered; satisfy the Pane behaviour with a no-op view.
  @impl true
  def view(_), do: []

  @impl true
  def react(:"turn/next", %Ui{} = ui, _forest), do: Ui.turn(ui, :next)
  def react(:"turn/prev", %Ui{} = ui, _forest), do: Ui.turn(ui, :prev)
  # Scroll the FOCUSED pane's text (answer or prompt) — ui.focus tells us which.
  def react(:"scroll/up", %Ui{focus: f} = ui, _forest), do: Ui.scroll(ui, f, -1)
  def react(:"scroll/down", %Ui{focus: f} = ui, _forest), do: Ui.scroll(ui, f, +1)
  def react(:"scroll/page-up", %Ui{focus: f} = ui, _forest), do: Ui.scroll(ui, f, -10)
  def react(:"scroll/page-down", %Ui{focus: f} = ui, _forest), do: Ui.scroll(ui, f, +10)
  def react(_intent, %Ui{} = ui, _forest), do: ui
end
