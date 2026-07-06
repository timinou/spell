defmodule SpellAgent.Tui.HintBar do
  @moduledoc """
  Render the one-line keybinding HINT bar shown under the composer (PLAN-025 W3,
  FEAT-041; reflected in FEAT-047).

  Given the current `focus` (which pane is active) and the focused pane's keymap
  `context`, produce `"<chord> <label> · …"` for a CURATED subset of the intents
  relevant to that focus plus the always-present globals. The bar is a glance —
  it names the few chords worth surfacing under each focus, with a terse label;
  the FULL binding set lives in the help overlay (`?`) and the command palette
  (`C-p`), which project every row.

  Each chord is resolved LIVE from `SpellAgent.Tui.KeymapIntrospect` — the ONE
  reflection of the keymap (compiled ⊕ live `KeymapRegistry` bindings, live
  override wins) that the help overlay and palette also read. So the hint can
  never drift from what the key actually does after a rebind, and adding a new
  context needs NO edit here (the former per-context `compiled_chord_for/2`
  dispatch — a clause-per-context hand-list — is gone).
  """

  alias SpellAgent.Tui.KeymapIntrospect

  @doc """
  The hint string for a given `focus` (`:tree | :detail | :prompt | …`) and the
  focused pane's keymap `context` name.
  """
  @spec render(atom(), atom()) :: String.t()
  def render(focus, context) do
    focused_hints =
      case focus do
        :tree ->
          [
            chord_hint(context, :"nav/next", "next"),
            chord_hint(context, :"nav/child", "in"),
            chord_hint(context, :"nav/parent", "out")
          ]

        :detail ->
          [chord_hint(context, :"scroll/down", "scroll")]

        :prompt ->
          [chord_hint(context, :"mode/insert", "type")]

        _ ->
          []
      end

    global = [
      chord_hint(:global, :"focus/next", "pane"),
      chord_hint(:global, :"app/help", "help"),
      chord_hint(:global, :"app/palette", "commands"),
      chord_hint(:global, :"app/reset-layout", "reset layout"),
      chord_hint(:global, :"app/quit", "quit")
    ]

    (focused_hints ++ global)
    |> Enum.reject(&is_nil/1)
    |> Enum.join(" · ")
  end

  # "<chord> <label>" for the chord currently bound to `intent` in `context`, or
  # nil if unbound (so the hint is omitted rather than showing a dangling label).
  defp chord_hint(context, intent, label) do
    case chord_for(context, intent) do
      nil -> nil
      chord -> "#{chord} #{label}"
    end
  end

  # The chord bound to `intent` in `context`, reflected from the LIVE keymap via
  # `KeymapIntrospect` (compiled ⊕ live, live override wins) — the SAME rows the
  # help overlay and palette project. Returns the chord string, or nil. Total:
  # `KeymapIntrospect.rows/0` already rescues a down registry to compiled-only.
  defp chord_for(context, intent) do
    ctx_s = to_string(context)
    intent_s = to_string(intent)

    Enum.find_value(KeymapIntrospect.rows(), fn row ->
      if row["context"] == ctx_s and row["intent"] == intent_s, do: row["chord"]
    end)
  end
end
