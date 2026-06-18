defmodule SpellAgent.Tui.Keymap.Global do
  @moduledoc """
  The GLOBAL keymap context (PLAN-346) — pane-agnostic verbs that resolve
  regardless of which pane has focus.

  This is the bottom of the resolver's context cascade: the focused pane's keymap
  is consulted FIRST, and any chord it doesn't bind falls through to here. So
  `C-j`/`C-k` (move between panes) work under every focus, while `C-l`/`C-h` are
  left to each pane to interpret contextually (expand/contract vs turn nav).

  It satisfies the same shape as a pane context — `keymap/0` (chord → intent) and
  `react/3` (intent → `Ui.t()'`) — so `SpellAgent.Tui.Keys` treats panes and the
  global layer uniformly. It is NOT a pane (no project/view); just the two halves
  the resolver needs.
  """

  alias SpellAgent.Tui.{Chord, Ui}

  @doc "This context's registry key (for live `keymap/bind` overrides)."
  @spec context_name() :: :global
  def context_name, do: :global

  @doc "Chord → intent for the global layer."
  @spec keymap() :: [{Chord.t(), atom()}]
  def keymap do
    [
      {Chord.parse("C-j"), :"focus/next"},
      {Chord.parse("C-k"), :"focus/prev"},
      # Tab is an alias for focus/next (cross-pane cycle) — a familiar fallback
      # alongside the ctrl chords.
      {Chord.parse("tab"), :"focus/next"},
      {Chord.parse("S-tab"), :"focus/prev"},
      {Chord.parse("esc"), :"app/quit"},
      {Chord.parse("C-c"), :"app/quit"}
    ]
  end

  @doc "Intent → new gaze for the global layer. Unknown intent = no-op (identity)."
  @spec react(atom(), Ui.t(), map()) :: Ui.t()
  def react(:"focus/next", %Ui{} = ui, _forest), do: Ui.focus(ui, :next)
  def react(:"focus/prev", %Ui{} = ui, _forest), do: Ui.focus(ui, :prev)
  # app/quit carries no Ui change; the App intercepts it before dispatch (it must
  # stop the runtime, which a pure Ui->Ui reaction cannot express). Identity here
  # so a stray dispatch is harmless.
  def react(:"app/quit", %Ui{} = ui, _forest), do: ui
  # app/submit is likewise App-intercepted (it starts a Task + resets the Store);
  # identity here so a stray dispatch can't corrupt the gaze.
  def react(:"app/submit", %Ui{} = ui, _forest), do: ui
  def react(_intent, %Ui{} = ui, _forest), do: ui
end
