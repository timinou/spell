defmodule SpellAgent.Tui.HintBar do
  @moduledoc """
  Render the one-line keybinding HINT bar shown under the composer (PLAN-025 W3,
  FEAT-041).

  Given the current `focus` (which pane is active) and the focused pane's keymap
  `context`, produce `"<chord> <label> · …"` for the intents relevant to that
  focus plus the always-present globals. Each chord is resolved LIVE: a runtime
  `KeymapRegistry` binding wins, else the compiled keymap — so the hint always
  reflects what the key actually does after a rebind.

  Extracted verbatim from the former `SpellAgent.Tui.App` god-module so the
  chord-resolution + hint-composition policy is unit-testable without a live
  terminal. The App shell now just computes `{focus, context}` and delegates here.
  """

  alias SpellAgent.Tui.{Chord, KeymapRegistry}
  alias SpellAgent.Tui.Keymap.{Global, Prompt, TurnNav}
  alias SpellAgent.Tui.Panes.SpanTree

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
      chord_hint(:global, :"app/reset-layout", "reset layout"),
      chord_hint(:global, :"app/quit", "quit")
    ]

    (focused_hints ++ global)
    |> Enum.reject(&is_nil/1)
    |> Enum.join(" · ")
  end

  # "<chord> <label>" for the chord currently bound to `intent` in `context`
  # (registry override first, then the compiled keymap), or nil if unbound.
  defp chord_hint(context, intent, label) do
    case chord_for(context, intent) do
      nil -> nil
      chord -> "#{Chord.to_string(chord)} #{label}"
    end
  end

  # Find a chord that resolves to `intent` in `context`: prefer a live registry
  # binding, else the compiled keymap. (First match wins; good enough for a hint.)
  defp chord_for(context, intent) do
    live = Enum.find_value(live_bindings(context), fn {c, i} -> if i == intent, do: c end)
    live || compiled_chord_for(context, intent)
  end

  # Registry bindings if the registry is running, else [] — so the hint still
  # renders (from compiled keymaps) when the App runs without the supervised
  # KeymapRegistry (e.g. a headless render test). try/rescue/catch rather than a
  # Process.whereis pre-check: the check is TOCTOU — the registry could exit
  # between whereis and the call, crashing the render path. The hint is
  # best-effort, so any failure degrades to compiled-keymap hints.
  defp live_bindings(context) do
    KeymapRegistry.bindings(context)
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  defp compiled_chord_for(:global, intent), do: keymap_chord(Global.keymap(), intent)
  defp compiled_chord_for(:tree, intent), do: keymap_chord(SpanTree.keymap(), intent)
  defp compiled_chord_for(:turn_nav, intent), do: keymap_chord(TurnNav.keymap(), intent)
  defp compiled_chord_for(:prompt, intent), do: keymap_chord(Prompt.keymap(), intent)
  defp compiled_chord_for(_other, _intent), do: nil

  defp keymap_chord(keymap, intent),
    do: Enum.find_value(keymap, fn {c, i} -> if i == intent, do: c end)
end
