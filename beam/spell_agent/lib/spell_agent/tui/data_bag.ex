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

  alias SpellAgent.Tui.{Sanitize, Store}

  # The canonical bag keys the assembler always produces. A reactive cell may ADD
  # a new data/* key but never SHADOW one of these (merge_cells lets core win), so
  # the cell-dependency cycle check must treat a dep on one of these as a LEAF
  # (the value is the core map, not a cell) even if a same-named cell exists.
  @core_keys MapSet.new(~w(
    area status ui vms forest cells
    running? turns tools forest-count composer
    status-label status-color composer-text composer-title composer-fg
  ))

  @doc "The canonical (core) bag keys — the keys the assembler always produces."
  @spec core_keys() :: MapSet.t()
  def core_keys, do: @core_keys

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
    build(state, area, snapshot(state))
  end

  @typedoc """
  A precomputed, ALREADY-SANITIZED snapshot of the forest-derived (heavy) bag
  members (PLAN-023 Task A). Holds the two O(forest) values — the sanitized span
  `forest` and the sanitized `vms` — plus the cheap forest-derived scalars
  (`turns`/`tools`/`forest-count`). These change ONLY when the store forest or the
  pane view-models change (a `reproject`), never on a bare keystroke, so caching
  them across keystroke renders removes the per-frame `Sanitize.term` + `Store.spans`
  cost that scaled render time with conversation size.
  """
  @type snapshot :: %{
          forest: term(),
          vms: term(),
          forest_count: non_neg_integer(),
          turns: non_neg_integer(),
          tools: non_neg_integer()
        }

  @doc """
  Build the forest snapshot from App `state` (reads the store once).

  Prefer `snapshot_from/2` when the caller already holds the spans map (the App's
  `reproject` does) to avoid a second `Store.spans` round-trip. Pure + total.
  """
  @spec snapshot(map()) :: snapshot()
  def snapshot(state) when is_map(state) do
    snapshot_from(safe_spans(state), Map.get(state, :vms, %{}))
  end

  @doc """
  Build the forest snapshot from an already-read `spans` map + `vms`.

  This is the ONE place the O(forest) `Sanitize.term` runs on the heavy members;
  the App calls it once per `reproject` and reuses the result across every
  keystroke render. Pure + total.
  """
  @spec snapshot_from(map(), term()) :: snapshot()
  def snapshot_from(spans, vms) when is_map(spans) do
    %{
      forest: Sanitize.term(spans),
      vms: vms |> stringify_vms() |> Sanitize.term(),
      forest_count: map_size(spans),
      turns: spans |> Store.run_spans() |> Enum.flat_map(& &1.turns) |> length(),
      tools: spans |> Store.tool_spans() |> length()
    }
  end

  @doc """
  Assemble the `data/*` bag reusing a precomputed forest `snap` (PLAN-023 Task A).

  The heavy members (`forest`, `vms`) and the forest-derived scalars come from
  `snap` ALREADY sanitized — render never re-sanitizes the forest. Only the light,
  per-frame members (area, status, gaze, composer presentation) are assembled and
  sanitized here, so a keystroke render's cost is independent of conversation size.
  A `nil` snap degrades to the eager `build/2` path (totality for headless callers).
  """
  @spec build(map(), map(), snapshot() | nil) :: t()
  def build(state, area, nil), do: build(state, area)

  def build(state, area, %{} = snap) when is_map(state) do
    light = state |> assemble_light(area, snap) |> Sanitize.term()
    heavy = %{"forest" => snap.forest, "vms" => snap.vms}
    light |> Map.merge(heavy) |> merge_cells()
  end

  # Merge the reactive cells' last off-frame-resolved values into the bag
  # (PROJ-004 W2). This is a PURE READ of the cell registry — no eval on the frame
  # clock — so the zero-per-frame-effects contract holds: the SLOW clock (W3) does
  # the resolving; here a render hole sees the result as ordinary `data/<cell>`.
  #
  # Core bag keys WIN over cells: a cell may ADD a new `data/*` key but must never
  # SHADOW a canonical one (`data/status`, `data/ui`, …). Values from the registry
  # are already sanitized at the cell boundary; we re-strip defensively so the bag
  # has ONE invariant regardless of the source. Resilient: a down/absent registry
  # (headless render test) yields no cells, never a raise.
  defp merge_cells(bag) do
    cells = resolved_cells()
    Map.merge(cells, bag)
  end

  defp resolved_cells do
    SpellAgent.Tui.Cell.Registry.resolved_values() |> Sanitize.term()
  rescue
    _ -> %{}
  catch
    :exit, _ -> %{}
  end

  # The declared cell list as data (PROJ-005): a tmpl:: hole reads data/cells
  # to render a cell browser/drawer. Mirrors cell/list's shape so the runtime
  # listing and the data projection never drift.
  defp cell_listing do
    SpellAgent.Tui.Cell.Registry.all()
    |> Enum.map(fn {name, cell} ->
      %{
        "name" => name,
        "deps" => MapSet.to_list(cell.deps),
        "debounce" => cell.debounce,
        "resolved" => cell.resolved != :unresolved
      }
    end)
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  # The LIGHT, per-frame bag members (PLAN-023 Task A): everything that is cheap to
  # derive on the frame clock — area, status, gaze, fine scalars, and the
  # status/composer presentation. The HEAVY forest-derived members (`forest`,
  # `vms`) and the forest-derived scalars (`turns`/`tools`/`forest-count`) come
  # from the precomputed `snap`, so this runs in O(1) of conversation size.
  defp assemble_light(state, area, snap) when is_map(state) do
    running? = Map.get(state, :running?, false)
    result = Map.get(state, :result)
    turns = snap.turns
    tools = snap.tools

    status = %{
      "running?" => running?,
      "result" => result_tag(result),
      "turns" => turns,
      "tools" => tools,
      "last-prompt" => Map.get(state, :last_prompt),
      "composer" => Map.get(state, :composer, "")
    }

    # Presentation projections (W5 dogfood): the status strip + composer render
    # from these keys via tmpl:: holes in the default layout, retiring the
    # hardcoded status_widget/composer_widget fills. The PRESENTATION lives in the
    # layout (data); the DERIVATION (label/color/hint) stays here as a projection.
    {status_label, status_color} = status_presentation(running?, result, turns, tools)
    {composer_text, composer_title, composer_fg} = composer_presentation(state)

    %{
      # ---- coarse maps (forest/vms are merged in by build/3 from the snap) ----
      "area" => area_map(area),
      "status" => status,
      "ui" => ui_map(Map.get(state, :ui)),
      "cells" => cell_listing(),
      # ---- fine-grained scalars (sharper diff keys; §8c.3) ----
      "running?" => running?,
      "turns" => turns,
      "tools" => tools,
      "forest-count" => snap.forest_count,
      "composer" => Map.get(state, :composer, ""),
      # ---- presentation keys (W5 dogfood: status/composer render from these) ----
      "status-label" => status_label,
      "status-color" => status_color,
      "composer-text" => composer_text,
      "composer-title" => composer_title,
      "composer-fg" => composer_fg
    }
  end

  # ---- presentation projections (W5) ----
  #
  # Mirror the retired status_widget/composer_widget EXACTLY: same label strings,
  # colors, modal title, and cursor glyph. The layout holds the widget shape; these
  # produce the dynamic content it shows.

  defp status_presentation(running?, result, turns, tools) do
    cond do
      running? -> {"● running…  turns #{turns} · tools #{tools}", "yellow"}
      match?({:ok, _}, result) -> {"✓ done  turns #{turns} · tools #{tools}", "green"}
      match?({:error, _}, result) -> {"✗ failed  turns #{turns} · tools #{tools}", "red"}
      result != nil -> {"✓ done  turns #{turns} · tools #{tools}", "green"}
      true -> {"idle — type a prompt below, then ↵", "dark_gray"}
    end
  end

  defp composer_presentation(state) do
    composer = Map.get(state, :composer, "")
    insert? = get_in_safe(state, [:ui, :mode]) == :insert
    title = if insert?, do: " prompt — INSERT ", else: " prompt — NORMAL "

    text =
      cond do
        insert? -> composer <> "▎"
        composer != "" -> composer
        true -> Map.get(state, :composer_hint, "")
      end

    fg = if insert? or composer != "", do: "white", else: "dark_gray"
    {text, title, fg}
  end

  defp get_in_safe(state, [k1, k2]) do
    case Map.get(state, k1) do
      m when is_map(m) -> Map.get(m, k2)
      _ -> nil
    end
  end

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
    focus = Map.get(ui, :focus)
    cursors = Map.get(ui, :cursors, %{})

    %{
      "focus" => to_string_safe(focus),
      "mode" => to_string_safe(Map.get(ui, :mode)),
      "turn" => Map.get(ui, :turn, 0),
      # The focused pane's row cursor + the full per-pane cursor map. Exposed so a
      # reactive cell keyed on the cursor (the headline PROJ-004 case) re-triggers
      # when the operator moves: a cursor move changes data/ui, which the slow
      # clock's dep-diff sees. Without this, data/ui would not reflect navigation
      # and cursor-keyed cells could never go live.
      "cursor" => Map.get(cursors, focus, 0),
      "cursors" => Map.new(cursors, fn {pane, idx} -> {to_string_safe(pane), idx} end),
      "flags" => Map.new(Map.get(ui, :flags, %{}), fn {k, v} -> {to_string_safe(k), v} end)
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
