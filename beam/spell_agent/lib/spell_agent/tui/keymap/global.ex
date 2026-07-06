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
      {Chord.parse("C-c"), :"app/quit"},
      {Chord.parse("C-r"), :"app/reset-layout"},
      {Chord.parse("C-e"), :"app/toggle-cells"},
      # C-o opens the multi-session cockpit (FEAT-046): the `body` slot is shadowed
      # with the live per-session card grid. C-r (reset-layout) returns to the
      # default inspector.
      {Chord.parse("C-o"), :"app/cockpit"},
      # C-w opens the FRAME leader: the next key (h/j/k/l) selects a region by
      # SPATIAL position in the layout tree (leftmost/rightmost/top/bottom),
      # resolved from live rect geometry. C-j/C-k cycle WITHIN a frame; C-w moves
      # BETWEEN regions. The App holds the one-shot pending state (the follow-up
      # key is not a static binding — it is resolved against the placed tree).
      {Chord.parse("C-w"), :"frame/leader"}
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
  # app/reset-layout is App-intercepted because it mutates the LayoutRegistry;
  # identity here so a stray dispatch can't corrupt the gaze.
  def react(:"app/reset-layout", %Ui{} = ui, _forest), do: ui
  # app/cockpit is App-intercepted (it shadows the body slot via Cockpit.show/0,
  # a LayoutRegistry mutation); identity here so a stray dispatch is harmless.
  def react(:"app/cockpit", %Ui{} = ui, _forest), do: ui
  # frame/leader is App-intercepted: it arms a one-shot pending state, then the
  # NEXT key is resolved spatially against the placed tree (geometry the pure
  # Ui->Ui reaction cannot see). Identity here so a stray dispatch is harmless.
  def react(:"frame/leader", %Ui{} = ui, _forest), do: ui
  # Toggle the cells drawer: flip the free-form flag a tmpl:: hole or the render
  # overlay reads. The flag is the ONLY state — the drawer content is derived from
  # data/cells each frame, so there is nothing to sync.
  def react(:"app/toggle-cells", %Ui{} = ui, _forest) do
    open = Map.get(ui.flags, "cells-drawer", false)
    %{ui | flags: Map.put(ui.flags, "cells-drawer", not open)}
  end

  def react(_intent, %Ui{} = ui, _forest), do: ui
end
