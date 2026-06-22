defmodule SpellAgent.Tui.DataBag do
  @moduledoc """
  The generic `data/*` environment a `tmpl::` hole resolves against (PLAN-012 W4)
  — the seam that makes deferred holes ZERO-cost to the runtime.

  ## The zero-cost property

  Before W4, every dynamic value reached the screen through bespoke Elixir
  (`app.ex` `status_widget/1`, `composer_widget/1`, compiled `Panes.*`). W4
  collects the live state into ONE generic bag, assembled once per frame, that
  `HoleResolver` binds as `data/*`. A hole references any value uniformly
  (`~(get data/status :model)`); ADDING a value is ONE key here — no new
  render-path Elixir, no recompiled fill function. Cost scales with the bag's
  key count, not with the number of holes.

  ## Coarse vs fine-grained keys (the §8c.3 tuning knob)

  The bag carries both:

    * COARSE maps — `data/status`, `data/area`, `data/ui` — convenient, but a hole
      reading one re-resolves whenever ANY field of that map changes (W6 dirty
      tracking keys on the top-level `data/*` name).
    * FINE-GRAINED scalars — `data/status-running?`, `data/turns`, `data/tools`,
      `data/forest-count` — so a hole that needs only one number does NOT depend
      on a whole coarse map. This is LiveView's fine-grained-assigns lesson: split
      the bag to sharpen diff precision. Adding a fine key is, again, one line —
      diff precision is tunable at ZERO render-path cost.

  All keys are STRING-keyed: PTC `data/<k>` reads string keys (`data/forest-count`
  -> `"forest-count"`).
  """

  alias SpellAgent.Tui.Store

  @typedoc "The `data/*` environment: string-keyed bindings a hole sees."
  @type t :: %{optional(String.t()) => term()}

  @doc """
  Assemble the `data/*` bag from the App `state` and the frame `area`.

  `state` is the App's render state map (`:store`, `:vms`, `:running?`,
  `:result`, `:composer`, `:ui`, `:last_prompt`, …). `area` is the frame rect.
  Pure + total: a missing/odd field degrades to a sensible default, never raises.
  """
  @spec build(map(), map()) :: t()
  def build(state, area) when is_map(state) do
    state |> assemble(area) |> sanitize()
  end

  defp assemble(state, area) when is_map(state) do
    spans = safe_spans(state)
    runs = Store.run_spans(spans)
    turns = runs |> Enum.flat_map(& &1.turns) |> length()
    tools = length(Store.tool_spans(spans))
    running? = Map.get(state, :running?, false)
    result = Map.get(state, :result)

    status = %{
      "running?" => running?,
      "result" => result_tag(result),
      "turns" => turns,
      "tools" => tools,
      "last-prompt" => Map.get(state, :last_prompt),
      "composer" => Map.get(state, :composer, "")
    }

    %{
      # ---- coarse maps ----
      "area" => area_map(area),
      "status" => status,
      "ui" => ui_map(Map.get(state, :ui)),
      "vms" => stringify_vms(Map.get(state, :vms, %{})),
      "forest" => spans,
      # ---- fine-grained scalars (sharper diff keys; §8c.3) ----
      "running?" => running?,
      "turns" => turns,
      "tools" => tools,
      "forest-count" => map_size(spans),
      "composer" => Map.get(state, :composer, "")
    }
  end

  # ---- sanitization (capability boundary, W3 review #1) ----
  #
  # A hole evaluates against `data/*` with no tools, but PTC can still CALL a
  # function value reachable from the context (and a span's `meta` can carry the
  # live LLM callback). So before exposing the bag we DEEP-STRIP every
  # non-serializable term — functions, pids, refs, ports — replacing it with nil.
  # What remains is plain data: maps, lists, scalars. A hole can read the shape of
  # the forest but can never recover an executable to invoke. Looking never acts.
  defp sanitize(term) when is_function(term), do: nil
  defp sanitize(term) when is_pid(term) or is_reference(term) or is_port(term), do: nil

  defp sanitize(%MapSet{} = set),
    do: set |> MapSet.to_list() |> Enum.map(&sanitize/1) |> MapSet.new()

  defp sanitize(%_{} = struct) do
    # A struct (e.g. a Span) -> a plain string-keyed map with each field stripped,
    # dropping the __struct__ tag so no module/behaviour leaks and the result is
    # pure data a hole can only read.
    struct
    |> Map.from_struct()
    |> Map.new(fn {k, v} -> {to_string_safe(k), sanitize(v)} end)
  end

  defp sanitize(map) when is_map(map),
    do: Map.new(map, fn {k, v} -> {sanitize_key(k), sanitize(v)} end)

  defp sanitize(list) when is_list(list), do: Enum.map(list, &sanitize/1)
  defp sanitize(tuple) when is_tuple(tuple), do: tuple |> Tuple.to_list() |> Enum.map(&sanitize/1)
  defp sanitize(other), do: other

  # Map keys must stay scalar (a stripped fn-key would collide on nil); coerce
  # atoms/strings, drop anything else to its inspected form.
  defp sanitize_key(k) when is_binary(k) or is_integer(k), do: k
  defp sanitize_key(k) when is_atom(k) and not is_nil(k), do: Atom.to_string(k)
  defp sanitize_key(k), do: inspect(k)

  # ---- helpers ----

  defp safe_spans(state) do
    case Map.get(state, :store) do
      nil -> %{}
      store -> Store.spans(store)
    end
  rescue
    _ -> %{}
  catch
    :exit, _ -> %{}
  end

  defp result_tag({:ok, _}), do: "ok"
  defp result_tag({:error, _}), do: "error"
  defp result_tag(nil), do: nil
  defp result_tag(_), do: "done"

  defp area_map(%{x: x, y: y, width: w, height: h}),
    do: %{"x" => x, "y" => y, "width" => w, "height" => h}

  defp area_map(_), do: %{"x" => 0, "y" => 0, "width" => 0, "height" => 0}

  # The gaze as a plain string-keyed map (mirrors Reaction.Ptc.ui_to_map shape).
  defp ui_map(nil), do: %{}

  defp ui_map(ui) when is_map(ui) do
    %{
      "focus" => to_string_safe(Map.get(ui, :focus)),
      "mode" => to_string_safe(Map.get(ui, :mode)),
      "turn" => Map.get(ui, :turn, 0)
    }
  end

  defp stringify_vms(vms) when is_map(vms),
    do: Map.new(vms, fn {k, v} -> {to_string_safe(k), v} end)

  defp stringify_vms(_), do: %{}

  defp to_string_safe(nil), do: nil
  defp to_string_safe(a) when is_atom(a), do: Atom.to_string(a)
  defp to_string_safe(s) when is_binary(s), do: s
  defp to_string_safe(other), do: inspect(other)
end
