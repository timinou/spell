defmodule SpellAgent.Tui.Reaction.Ptc do
  @moduledoc """
  Runs a runtime-authored reaction (PLAN-346 W3) — the homoiconic write-mirror.

  A reaction stored via `(keymap/define-reaction …)` is PTC-Lisp SOURCE TEXT
  (code-as-data). When its intent fires, `SpellAgent.Tui.Keys.dispatch/4` calls
  `run/3` here, which evaluates that source through the SAME sandboxed
  `PtcRunner.Lisp.run/2` the `execute`/`define-tool` paths use, with:

    * the current gaze bound as `data/ui` (a plain map), and
    * the live span forest bound as `data/forest`, and
    * the `harness/` + `keymap/` namespaces registered in the tools map.

  The program returns a gaze (a Ui map — e.g. the result of threading
  `harness/expand`/`harness/cursor` over `(harness/state)`); `run/3` rehydrates it
  back into a `%Ui{}`. On any failure the ORIGINAL gaze is returned unchanged — a
  broken reaction must never corrupt navigation (fail-safe, like a render that
  raises is skipped in ExRatatui).

  This is the exact dual of `SpellAgent.Tools.to_callable/1` for `:ptc` tools:
  a reaction IS a tool whose param is your gaze and whose return is your next gaze.
  """

  alias SpellAgent.Harness
  alias SpellAgent.Tui.Ui

  @doc """
  Evaluate `source` as a reaction over `ui` (the current gaze) given `forest`.
  Returns the new `%Ui{}`, or the unchanged `ui` if the program fails.
  """
  @spec run(String.t(), Ui.t(), map()) :: Ui.t()
  def run(source, %Ui{} = ui, forest) when is_binary(source) and is_map(forest) do
    context = %{"ui" => ui_to_map(ui), "forest" => forest}
    # Close the CURRENT gaze into the harness tools so a verb called without an
    # explicit :ui (e.g. `(harness/expand {})` or `(harness/state)`) acts on it.
    tools = Harness.tools(forest, ui)

    case PtcRunner.Lisp.run(source, context: context, tools: tools, caller: :in_process_v1) do
      {:ok, step} -> rehydrate(step.return, ui)
      {:error, _step} -> ui
    end
  rescue
    # A reaction must never crash the App; degrade to the unchanged gaze.
    _ -> ui
  end

  # The program's return is a gaze map (string/atom keys) — rehydrate to %Ui{}.
  # Anything unrecognized (a non-map return) leaves the gaze untouched.
  # Rehydrate a returned gaze map into a %Ui{}. EVERY field is coerced through a
  # bounded validator (atom-table-DoS + corrupt-gaze defense, PLAN-346 W3r):
  #   * pane/focus/leader   -> Ui.safe_pane (known atoms only, never interned)
  #   * visibility values   -> Ui.safe_visibility
  #   * auto_depth/turn     -> non-negative integer or the prior value
  #   * cursors/scroll keys -> known panes only
  # A field the reaction omits or sets to an invalid value keeps the PRIOR gaze's
  # value, so a malformed return can never produce a %Ui{} that crashes a later
  # render (e.g. a string auto_depth breaking `depth < auto_depth`).
  defp rehydrate(result, %Ui{} = ui) when is_map(result) and not is_struct(result) do
    %Ui{
      focus: Ui.safe_pane(fetch(result, "focus")) || ui.focus,
      panes: panes(fetch(result, "panes"), ui.panes),
      mode: Ui.safe_mode(fetch(result, "mode")) || ui.mode,
      cursors: pane_keyed(fetch(result, "cursors"), ui.cursors),
      auto_depth: non_neg_int(fetch(result, "auto_depth"), ui.auto_depth),
      overrides: overrides(fetch(result, "overrides"), ui.overrides),
      turn: non_neg_int(fetch(result, "turn"), ui.turn),
      scroll: pane_keyed(fetch(result, "scroll"), ui.scroll),
      leader: Ui.safe_pane(fetch(result, "leader")),
      flags: Ui.safe_flags(fetch(result, "flags")) || ui.flags
    }
  end

  defp rehydrate(_other, %Ui{} = ui), do: ui

  # Mirror of Harness.ui_map/1 so the round-trip is lossless.
  defp ui_to_map(%Ui{} = ui) do
    %{
      "focus" => to_string(ui.focus),
      "panes" => Enum.map(ui.panes, &to_string/1),
      "mode" => to_string(ui.mode),
      "cursors" => stringify_kv(ui.cursors),
      "auto_depth" => ui.auto_depth,
      "overrides" => stringify_kv(ui.overrides),
      "turn" => ui.turn,
      "scroll" => stringify_kv(ui.scroll),
      "leader" => ui.leader && to_string(ui.leader)
    }
  end

  # ---- coercion helpers ----

  defp fetch(m, key) when is_map(m), do: Map.get(m, key) || Map.get(m, safe_atom(key))

  # Panes: keep only known pane atoms; fall back to the prior ring if empty/invalid.
  defp panes(nil, fallback), do: fallback

  defp panes(list, fallback) when is_list(list) do
    case Enum.flat_map(list, fn p -> List.wrap(Ui.safe_pane(p)) end) do
      [] -> fallback
      panes -> panes
    end
  end

  defp panes(_other, fallback), do: fallback

  # cursors/scroll: keyed by known panes only (unknown keys dropped, never
  # interned); non-int values dropped.
  defp pane_keyed(nil, fallback), do: fallback

  defp pane_keyed(m, _fallback) when is_map(m) do
    for {k, v} <- m, p = Ui.safe_pane(k), is_integer(v) and v >= 0, into: %{}, do: {p, v}
  end

  defp pane_keyed(_other, fallback), do: fallback

  # overrides: span-id STRING keys (kept as strings) -> :expanded/:collapsed only.
  defp overrides(nil, fallback), do: fallback

  defp overrides(m, _fallback) when is_map(m) do
    for {k, v} <- m, vis = Ui.safe_visibility(v), into: %{}, do: {to_string(k), vis}
  end

  defp overrides(_other, fallback), do: fallback

  defp non_neg_int(n, _fallback) when is_integer(n) and n >= 0, do: n
  defp non_neg_int(_other, fallback), do: fallback

  defp stringify_kv(m) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string(k), stringify_val(v)} end)
  defp stringify_val(v) when is_atom(v) and not is_nil(v), do: to_string(v)
  defp stringify_val(v), do: v

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end
end
