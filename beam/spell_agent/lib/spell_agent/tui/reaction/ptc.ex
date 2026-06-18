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
  defp rehydrate(result, %Ui{} = ui) when is_map(result) and not is_struct(result) do
    %Ui{
      focus: atomize(fetch(result, "focus")) || ui.focus,
      panes: panes(fetch(result, "panes"), ui.panes),
      cursors: kv_atom_keys(fetch(result, "cursors"), ui.cursors),
      auto_depth: fetch(result, "auto_depth") || ui.auto_depth,
      overrides: overrides(fetch(result, "overrides"), ui.overrides),
      turn: fetch(result, "turn") || ui.turn,
      scroll: kv_atom_keys(fetch(result, "scroll"), ui.scroll),
      leader: atomize(fetch(result, "leader"))
    }
  end

  defp rehydrate(_other, %Ui{} = ui), do: ui

  # Mirror of Harness.ui_map/1 so the round-trip is lossless.
  defp ui_to_map(%Ui{} = ui) do
    %{
      "focus" => to_string(ui.focus),
      "panes" => Enum.map(ui.panes, &to_string/1),
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

  defp panes(nil, fallback), do: fallback
  defp panes(list, _fallback) when is_list(list), do: Enum.map(list, &atomize/1)

  defp kv_atom_keys(nil, fallback), do: fallback
  defp kv_atom_keys(m, _fallback) when is_map(m), do: Map.new(m, fn {k, v} -> {atomize(k), v} end)

  defp overrides(nil, fallback), do: fallback
  defp overrides(m, _fallback) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string(k), atomize(v)} end)

  defp stringify_kv(m) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string(k), stringify_val(v)} end)
  defp stringify_val(v) when is_atom(v) and not is_nil(v), do: to_string(v)
  defp stringify_val(v), do: v

  defp atomize(nil), do: nil
  defp atomize(a) when is_atom(a), do: a
  defp atomize(s) when is_binary(s), do: String.to_atom(s)

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end
end
