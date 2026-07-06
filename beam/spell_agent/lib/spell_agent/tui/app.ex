defmodule SpellAgent.Tui.App do
  @moduledoc """
  The inspector TUI (PLAN-345 spike) — an `ExRatatui.App` callback runtime that
  ties the spine together:

    composer (type a mission) --Enter--> Session.run in a Task --emit telemetry-->
    Store (span forest) --{:store_updated}--> re-project dirty panes --> render.

  ## Why a Task for the mission

  `Session.run/1` blocks until the agent finishes. Running it in a `Task` keeps
  the App responsive AND lets the run's telemetry stream into the Store live, so
  the span tree fills in as the model works — the whole point.

  ## State

    * `:store`       — the `SpellAgent.Tui.Store` pid this App mirrors.
    * `:panes`       — pane specs `%{name, module, assigns}`; `assigns` holds the
                       per-pane ui-state (cursor) the projection is scoped by.
    * `:vms`         — cached per-pane view-models (`SpellAgent.Tui.Projection`).
    * `:composer`    — the prompt buffer (plain string; keys handled directly so
                       the spike has no NIF-state coupling and stays test-headless).
    * `:on_submit`   — `(String.t() -> any())` run in a Task on Enter.
    * `:running?`    — whether a mission Task is in flight (composer shows status).

  Cursor/focus live HERE, never in the Store — the model forest stays a clean,
  replayable source of truth (PLAN-345 decision).
  """

  use ExRatatui.App

  require Logger

  alias ExRatatui.Layout.Rect
  alias SpellAgent.Hist

  alias SpellAgent.Tui.{
    Cell,
    Chord,
    DataBag,
    DataSource,
    DefaultLayout,
    ForestDiff,
    HintBar,
    HoleAffordance,
    Keys,
    KeymapRegistry,
    Lens,
    LayoutRegistry,
    Projection,
    Render,
    Spatial,
    Store,
    Surface,
    Ui
  }

  alias SpellAgent.Tui.Keymap.{Global, Prompt, TurnNav}
  alias SpellAgent.Tui.Panes.{Detail, History, SpanTree}

  # PLAN-346 W5: two projected panes — the span TREE (navigate) and the DETAIL
  # inspector (full content of the selected node). The prompt/composer is rendered
  # by the App directly, not as a projected pane.
  @default_panes [
    %{name: :history, module: History, assigns: %{}},
    %{name: :tree, module: SpanTree, assigns: %{}},
    %{name: :detail, module: Detail, assigns: %{}}
  ]

  # PLAN-023 Task C: the store-update COALESCING window (ms). A running mission
  # broadcasts {:store_updated, suffix} on every telemetry event; reprojecting +
  # rendering per event floods the App's single mailbox and starves keystrokes
  # ("char shows next tick"). Instead the first update arms a one-shot flush timer
  # and accumulates the dirty suffix set; all updates within the window collapse
  # into ONE reproject when :flush_store fires. ~one frame (16ms) is invisible to a
  # human for streamed spans but collapses a tight telemetry burst. Tests can pass
  # `store_coalesce_ms: 0` to flush on the next mailbox turn (deterministic).
  @store_coalesce_ms 16

  # PLAN-024 Wave 3 (FEAT-020): the registry context every generated hole-
  # affordance binding/reaction lives under — pushed to the TOP of
  # focus_stack/1 (most-specific-first) whenever the FOCUSED node carries a
  # live hole-affordance declaration.
  @hole_affordance_context :hole_affordance

  # ---- mount ----

  @impl true
  def mount(opts) do
    store = opts[:store] || Store
    Store.attach(store)
    Store.subscribe(store)

    # PLAN-003 SEAM 4 (RESUME): bind a durable conversation. Reopen the most recent
    # recorded session, or mint a fresh id when there is none / history is off.
    # `:hist_store` lets tests inject Store.Memory; `:hist_session` pins an id.
    hist_store = opts[:hist_store] || Hist.default_store()
    hist_session = opts[:hist_session] || resume_session_id(hist_store)

    state = %{
      store: store,
      hist_store: hist_store,
      hist_session: hist_session,
      panes: opts[:panes] || @default_panes,
      vms: %{},
      composer: "",
      on_submit: opts[:on_submit] || (&default_submit(&1, hist_session, hist_store)),
      running?: false,
      result: nil,
      last_prompt: nil,
      # The serializable gaze (PLAN-346 W5) — ALL navigation state incl. the modal
      # `mode`. Launch is PROMPT focus in NORMAL mode: press Enter to enter INSERT
      # and type a mission. The ring is prompt ↔ tree ↔ detail under C-j/C-k.
      ui:
        opts[:ui] ||
          Ui.new(focus: :prompt, mode: :normal, panes: [:prompt, :history, :tree, :detail]),
      # PROJ-004 reactive cells: the last data/* bag (for slow-clock dep-change
      # detection), the per-cell debounce timers (chord -> coalesced resolve), the
      # per-cell dispatch GENERATION (orders overlapping resolves of the same query
      # + drops stale ticks — W3r), and the last frame area (so the cell bag sees
      # the real terminal size, not a zero rect — W3r). Area defaults to a sane
      # non-zero size until the first render/resize.
      cell_bag: nil,
      cell_timers: %{},
      cell_gens: %{},
      last_area: %Rect{x: 0, y: 0, width: 80, height: 24},
      # PLAN-023 Task A: the cached, ALREADY-SANITIZED forest snapshot (sanitized
      # span forest + vms + forest-derived scalars). Recomputed ONCE per reproject
      # (store update / navigation) and reused by every keystroke render, so a
      # render no longer re-reads Store.spans or re-runs the O(forest)
      # Sanitize.term per frame. nil until the first reproject (mount runs one
      # below, so it is warm before the first render); a nil cache degrades the
      # render path to the eager DataBag.build/2 (totality).
      data_cache: nil,
      # PLAN-023 Task C: store-update coalescing. `store_dirty` accumulates the
      # suffixes (or :all) of {:store_updated} messages seen since the last flush;
      # `store_flush_timer` is the one-shot :flush_store timer ref (nil = none
      # armed). A telemetry burst accumulates into store_dirty and reprojects ONCE
      # when the timer fires, instead of once per event. `store_coalesce_ms` is the
      # window (overridable for deterministic tests).
      store_dirty: nil,
      store_flush_timer: nil,
      store_coalesce_ms: opts[:store_coalesce_ms] || @store_coalesce_ms,
      # The FRAME leader's one-shot pending flag (C-w): set when C-w is pressed,
      # consumed by the very next key (resolved spatially against the placed
      # tree), then cleared. nil = no leader armed.
      pending_leader: false
    }

    # Seed the canonical layout tree (PLAN-009) from the native default + the
    # starting gaze, so the LayoutRegistry the agent reshapes and the App render
    # share ONE tree. Best-effort: a headless test may run without the supervised
    # registry, in which case render falls back to the native default built from
    # state (so mount never depends on the registry being up).
    seed_layout(state)

    # PLAN-027 M0: register the query-clock data sources the surface ships with.
    # The render loop names none of them — it resolves whatever is registered.
    # `Cockpit.install/0` registers `data/sessions` (the multi-session overview).
    # Best-effort: a headless test without the supervised registry no-ops.
    install_data_sources()

    {:ok, reproject(state, :all)}
  end

  # Install the native default tree (structure + initial gaze tags) as the
  # LayoutRegistry's default + current tree. Tolerant of an absent registry.
  defp seed_layout(state) do
    pane_names = Enum.map(state.panes, &Atom.to_string(&1.name))
    LayoutRegistry.seed_default(DefaultLayout.tree(state.ui, pane_names))
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end
  # Register the query-clock data sources the surface ships with (PLAN-027 M0).
  # Each is a PERIPHERY policy call; the render loop stays feature-agnostic — it
  # resolves whatever DataSource.Registry holds, naming no specific source.
  # Best-effort: an absent registry (headless) degrades to a no-op, never raises.
  defp install_data_sources do
    SpellAgent.Tui.Cockpit.install()
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end
  # The resolver context stack for the current focus (PLAN-346 W5): the focused
  # pane's context FIRST, then the global layer. The SAME chord (h/l) resolves
  # differently by which context tops the stack — SpanTree (tree nav) under tree
  # focus, TurnNav (turn nav + scroll) under detail/prompt focus.
  # PLAN-024 Wave 3 (FEAT-020): when the CURRENTLY FOCUSED node carries a live
  # hole-affordance (`sync_hole_affordances/1` keeps the registry in lockstep
  # with focus), its context is pushed to the TOP of the stack — most-specific-
  # first, exactly the resolver's existing precedence rule. This is a data-
  # driven prefix, not a new dispatch branch: every focus_stack/1 clause below
  # is UNCHANGED, this just conses one more (already-live-data-driven) context
  # in front when applicable.
  defp focus_stack(state) do
    case hole_affordance_active?(state) do
      true -> [@hole_affordance_context | base_focus_stack(state)]
      false -> base_focus_stack(state)
    end
  end

  # The registry (kept in lockstep with the focused node by
  # sync_hole_affordances/1 on every reproject/2) is the source of truth for
  # "is there a live affordance right now" — no separate state check needed,
  # by construction it can never be stale between two reprojects.
  defp hole_affordance_active?(_state) do
    KeymapRegistry.bindings(@hole_affordance_context) != []
  rescue
    _ -> false
  catch
    :exit, _ -> false
  end

  defp base_focus_stack(%{ui: %Ui{focus: :tree}}), do: [SpanTree, Global]
  defp base_focus_stack(%{ui: %Ui{focus: :prompt}}), do: [Prompt, Global]
  defp base_focus_stack(%{ui: %Ui{focus: :detail}}), do: [TurnNav, Global]
  # History is a scrollable transcript like Detail — j/k/page scroll via TurnNav.
  defp base_focus_stack(%{ui: %Ui{focus: :history}}), do: [TurnNav, Global]

  # A PLAN-024 Wave 1 (FUP-005) runtime-declared pane: no compiled context
  # module exists for it, so its OWN atom is pushed as the context — `Keys`
  # resolves it purely against LIVE `KeymapRegistry` bindings/reactions keyed
  # under that same atom (compiled_intent/compiled_react degrade to nil/no-op
  # for an uncompiled context, guarded in `Keys`). Falls through to Global for
  # any chord the pane hasn't bound itself. `PaneRegistry.known?/1` is the
  # bounded membership check (never interns); anything else (a focus atom this
  # session never declared) still degrades to Global-only, unchanged behavior.
  defp base_focus_stack(%{ui: %Ui{focus: f}}) when is_atom(f) and not is_nil(f) do
    if runtime_pane?(f), do: [f, Global], else: [Global]
  end

  defp base_focus_stack(_), do: [Global]

  defp runtime_pane?(f) do
    SpellAgent.Tui.PaneRegistry.known?(f)
  rescue
    _ -> false
  catch
    :exit, _ -> false
  end

  # ---- render ----

  # The render mirror (PLAN-009 + PLAN-012): ONE path. Build the layout TREE from
  # the active panes + the live gaze, RESOLVE its tmpl:: holes against the data/*
  # bag (W3/W4), walk it (`Surface.layout`), and resolve each placed node — a
  # native `"pane"` node through the project/view/materialize machinery, every
  # other leaf (incl. the status/composer slots, now hole-bearing data — W5
  # dogfood) straight through `Materialize`. The agent can shadow any slot in
  # `LayoutRegistry`; when it has, that subtree is used (same walk).
  #
  # The result order is [status, panes-in-tree-order, composer] — preserved by the
  # tree's structure (status first child, body panes, composer last).
  @impl true
  def render(state, frame) do
    area = %Rect{x: 0, y: 0, width: frame.width, height: frame.height}

    # Resolve any deferred tmpl:: holes against the generic data/* bag (PLAN-012
    # W3/W4) BEFORE layout: an agent-authored slot may carry live holes, and this
    # is the one place a frozen form becomes a value. Native nodes carry no holes,
    # so the walk is a cheap identity for them; it never raises (per-hole ladder).
    # The composer hint is keymap-derived (live registry + compiled keymaps), so it
    # stays an App projection; inject it so DataBag can expose data/composer-text
    # without DataBag needing the keymap layer.
    data_bag =
      DataBag.build(
        Map.put(state, :composer_hint, hint_for(state)),
        area,
        Map.get(state, :data_cache)
      )

    state
    |> render_tree()
    |> Surface.resolve_holes(data_bag)
    |> Surface.layout(area)
    |> Enum.flat_map(fn {node, rect} -> Render.safe_resolve_node(node, rect, state) end)
    |> Enum.filter(&Render.encodable_placement?/1)
    |> maybe_cells_drawer(state, data_bag, area)
  end

  # The cells drawer (default: Ctrl-e): a right-side card overlay listing every
  # declared reactive cell + its resolve status + deps. The toggle is a keymap
  # reaction that flips ui.flags["cells-drawer"]; the content is derived from
  # data/cells each frame — pure data in, widget out, nothing to sync. Degrades to
  # no overlay when the flag is unset or Materialize fails (never bricks a frame).
  defp maybe_cells_drawer(placements, state, data_bag, area) do
    if Map.get(state.ui.flags, "cells-drawer", false) do
      placements ++ cells_drawer_placements(data_bag, area)
    else
      placements
    end
  end

  defp cells_drawer_placements(data_bag, area) do
    cells = Map.get(data_bag, "cells", [])

    items =
      case cells do
        [] ->
          ["(no cells defined)"]

        _ ->
          Enum.map(cells, fn c ->
            mark = if Map.get(c, "resolved"), do: "✓", else: "·"
            deps = Map.get(c, "deps", []) |> Enum.join(" ")
            deps_str = if deps == "", do: "", else: "  [#{deps}]"
            "#{mark} #{Map.get(c, "name", "?")}#{deps_str}"
          end)
      end

    node = %{
      "type" => "list",
      "items" => items,
      "block" => %{"type" => "block", "title" => " cells ", "borders" => ["all"]}
    }

    case SpellAgent.Tui.Materialize.to_struct(node) do
      %{__struct__: _} = widget ->
        w = min(34, area.width)
        rect = %Rect{x: max(0, area.width - w), y: 0, width: w, height: area.height}
        [{widget, rect}]

      _ ->
        []
    end
  rescue
    _ -> []
  end


  # The tree to render: the agent-shadowed tree from LayoutRegistry if it is
  # running AND its pane set matches the App's current panes; otherwise the native
  # default built fresh from state (the always-available baseline + the test path,
  # which runs without the supervised registry). Either way the gaze is folded in
  # from `state.ui` so navigation is reflected.
  defp render_tree(state) do
    pane_names = Enum.map(state.panes, &Atom.to_string(&1.name))
    native = DefaultLayout.tree(state.ui, pane_names)

    case live_layout_tree(pane_names) do
      nil -> native
      shadowed -> Lens.from_ui(shadowed, state.ui)
    end
  end

  # The LayoutRegistry's tree, but only when it is the tree for the App's CURRENT
  # pane set (so a 2-pane test never picks up a 3-pane live tree, and the registry
  # being absent in a headless test degrades to the native default).
  #
  # The gate keys on the registry's FROZEN pane identity (`pane_identity/0`),
  # captured at seed time, NOT on a recomputed `body_pane_slots/1` of the LIVE
  # tree. The live tree's body changes shape under the agent's reshapes:
  #
  #   * BUG-007: shadowing a PANE slot (e.g. `detail`) with a widget drops it from
  #     `focusables/1`. Fixed by switching to `body_pane_slots/1`.
  #   * BUG-012: shadowing the BODY slot itself with a `view/split` whose children
  #     are fresh widgets (NO slot) makes `body_pane_slots/1` of the live tree `[]`
  #     -- so a live recompute fails the equality and the WHOLE reshape silently
  #     un-adopts, every frame. The very feature the prompt advertises ("body is
  #     your canvas") was structurally forbidden by gating on the mutable body.
  #
  # The frozen identity is the stable invariant: it answers "is this the registry
  # for THESE panes" once, at seed, and never moves under a reshape. Read the tree
  # and its identity ATOMICALLY so they can't tear across a concurrent set/2.
  defp live_layout_tree(pane_names) do
    {tree, identity} = LayoutRegistry.tree_with_identity()

    cond do
      identity == pane_names ->
        tree

      true ->
        # The registry is for a different pane set (or unseeded). Fall back to the
        # native default -- but say so: a SILENT discard is the BUG-012 trap (the
        # agent's set/2 returned ok yet nothing rendered, with no signal anywhere).
        Logger.debug(
          "render: layout registry not adopted -- pane identity #{inspect(identity)} " <>
            "!= app panes #{inspect(pane_names)}; using native default"
        )

        nil
    end
  rescue
    _ -> nil
  catch
    :exit, _ -> nil
  end


  # ---- events: MODAL resolver path (PLAN-346 W5) ----

  # Mode gates everything. INSERT: the composer owns the keyboard — Esc returns to
  # NORMAL, Enter submits, everything else edits text. NORMAL: every key is a
  # %Chord{} resolved against the focus context stack (no key types text). This
  # is why plain j/k/h/l can be navigation — they're only text in INSERT mode.
  # FRAME leader consume (C-w armed): the NEXT key is a spatial direction. Resolve
  # it against the LIVE placed tree (real rect geometry, the C-e drawer included
  # when shown) and focus the extreme region. Any non-direction key just disarms
  # (a harmless cancel). One-shot: pending_leader is always cleared here. This
  # clause precedes the modal handlers so the leader wins over text/nav.
  @impl true
  def handle_event(%ExRatatui.Event.Key{kind: kind} = key, state)
      when kind in ["press", "repeat"] do
    chord = Chord.from_event(key)

    if reset_layout_chord?(chord) do
      {:noreply, reset_layout(state)}
    else
      handle_key_event(chord, state)
    end
  end

  def handle_event(_event, state), do: {:noreply, state}

  defp handle_key_event(%Chord{} = chord, %{pending_leader: true} = state) do
    state = %{state | pending_leader: false}

    case Spatial.direction(chord.key) do
      nil ->
        # Not a direction — cancel the leader, consume the key (no stray action).
        {:noreply, state}

      dir ->
        target = Ui.safe_pane(frame_target(state, dir))
        ui = Ui.focus_pane(state.ui, target)
        {:noreply, reproject(%{state | ui: ui}, :all)}
    end
  end

  defp handle_key_event(%Chord{} = chord, %{ui: %Ui{mode: :insert}} = state) do
    cond do
      chord.key == "esc" ->
        # Leave INSERT without submitting; keep the composer buffer.
        {:noreply, %{state | ui: Ui.mode(state.ui, :normal)}}

      chord.key == "enter" and chord.mods == [] ->
        submit(state)

      true ->
        {:noreply, compose(chord, state)}
    end
  end

  # FEAT-039: system intents (app/quit, frame/leader, mode/insert) are resolved
  # through the SAME `Keys.resolve/2` cascade as every other intent — a live
  # `keymap/bind` already rebinds WHICH chord triggers them (KeymapRegistry is
  # consulted before the compiled keymap, same as any pane intent). What these
  # three clauses intercept is the REACTION side: `app/quit` stops the App (a
  # pure Ui->Ui reaction cannot express `:stop` — no gaze value means "halt the
  # runtime") and `frame/leader` arms App-only `pending_leader` state (not a
  # tree/gaze field). Both are therefore PROTECTED — never redefinable via
  # `keymap/define-reaction` — by design, documented in
  # docs/freeform-tui-architecture.md #9. `mode/insert` has no such App-only
  # need, so it is NOT protected: a live reaction registered via
  # `keymap/define-reaction` for this ctx+intent wins over the hardcoded
  # default, exactly like every other intent's dispatch (`Keys.dispatch`
  # already prefers a live reaction over the compiled `react/3` — this clause
  # now honors that same precedence instead of short-circuiting around it).
  defp handle_key_event(%Chord{} = chord, %{ui: %Ui{mode: :normal}} = state) do
    case Keys.resolve(chord, focus_stack(state)) do
      {:intent, :"app/quit", _ctx} ->
        # Intentionally protected (never redefinable) — see moduledoc note above.
        {:stop, state}

      {:intent, :"frame/leader", _ctx} ->
        # Intentionally protected (never redefinable) — see moduledoc note above.
        # Arm the FRAME leader (C-w): the next key picks a region spatially.
        {:noreply, %{state | pending_leader: true}}

      {:intent, :"mode/insert", ctx} = resolution ->
        if live_reaction?(ctx, :"mode/insert") do
          dispatch_generic(resolution, state)
        else
          # Default behavior: enter INSERT — only meaningful on the prompt; focus
          # it so typing is visibly directed there.
          {:noreply, %{state | ui: state.ui |> Ui.focus(:prompt) |> Ui.mode(:insert)}}
        end

      {:intent, :"app/submit", _ctx} ->
        # `enter` on a non-prompt pane (where mode/insert isn't bound) runs the
        # current composer buffer directly.
        submit(state)

      {:intent, :"app/reset-layout", _ctx} ->
        reset_layout(state) |> then(&{:noreply, &1})

      {:intent, _intent, _ctx} = resolution ->
        dispatch_generic(resolution, state)

      :unbound ->
        # In NORMAL an unbound key does NOTHING (no stray text — that's INSERT).
        {:noreply, state}
    end
  end

  defp handle_key_event(%Chord{}, state), do: {:noreply, state}

  # Shared generic-intent dispatch path: run the resolved intent through
  # `Keys.dispatch/6` (compiled react/3 OR a live PTC reaction, whichever wins)
  # and re-mirror every pane off the resulting gaze. Used both by the fallback
  # `{:intent, _intent, _ctx}` clause AND by `mode/insert` when a live reaction
  # has been authored for it (FEAT-039) — one dispatch path, no duplication.
  defp dispatch_generic(resolution, state) do
    forest = Store.spans(state.store)
    # PLAN-024 Wave 2 (FUP-031): thread the LIVE tree through so an authored
    # reaction can call lens/frame-target (the same spatial primitive the
    # native C-w keybinding uses) — without this, lens/* is unreachable from
    # a real dispatched reaction (only harness/+keymap/ would be).
    #
    # PLAN-024 Wave 3 (FEAT-020): also thread mesh_opts so a hole-affordance
    # reaction can call black/post (e.g. posting a :resolution when its bound
    # chord fires). session_id = hist_session (already a stable per-session
    # identifier — no new concept introduced); region = the SAME id, so a
    # hole-affordance's decision/resolution records live in this session's
    # own mesh region by default.
    mesh_opts = %{session_id: state.hist_session, region: state.hist_session, store: state.hist_store}
    ui = Keys.dispatch(resolution, state.ui, forest, &Keys.context_name/1, render_tree(state), mesh_opts)
    # Navigation changed the gaze → re-mirror every pane (the detail pane
    # mirrors the new selection; cheap, gaze-fed projection).
    {:noreply, reproject(%{state | ui: ui}, :all)}
  end

  # Is there a LIVE (agent-authored) reaction registered for this ctx+intent?
  # Used to decide whether `mode/insert` should run the hardcoded default
  # (focus prompt + enter INSERT) or the agent's own redefinition — the same
  # "live reaction wins" precedence `Keys.dispatch/6` already applies to every
  # OTHER intent, made explicit here since this clause needs to pick its
  # branch BEFORE calling dispatch.
  defp live_reaction?(ctx, intent) do
    name = Keys.context_name(ctx)
    KeymapRegistry.lookup_reaction(name, intent) != nil
  rescue
    _ -> false
  catch
    :exit, _ -> false
  end

  defp reset_layout_chord?(%Chord{key: "r", mods: [:ctrl]}), do: true
  defp reset_layout_chord?(_chord), do: false

  defp reset_layout(state) do
    LayoutRegistry.reset(nil)
    %{state | pending_leader: false} |> reproject(:all)
  rescue
    _ -> %{state | pending_leader: false}
  catch
    :exit, _ -> %{state | pending_leader: false}
  end

  # ---- frame leader: spatial region resolution (C-w) ----

  # The slot of the region in `dir` (left/right/up/down), resolved PURELY from the
  # live tree's geometry: lay the current tree into the last known frame area, pair
  # each focusable region with the rect it occupies THIS frame, add the C-e cells
  # drawer as a region when it is shown (rightmost overlay), and ask `Spatial` for
  # the extreme. So "most rightward" is whichever region the layout placed furthest
  # right — the cells drawer when open, else the rightmost body pane. nil when
  # there is nothing placed (degraded tree) → focus_pane is then identity.
  #
  # PLAN-024 Wave 2 (FUP-031): `frame_regions/1` is now a THIN caller of
  # `Lens.pane_regions/3` (the same primitive the `lens/frame-target` PTC verb
  # calls) plus the App-only cells-drawer overlay `Lens` has no state to know
  # about — one source of truth for the geometry, the App only adds what only
  # the App can see.
  defp frame_target(state, dir) do
    state |> frame_regions() |> Spatial.extreme(dir)
  end

  # `[{slot, %Rect{}}]` for every focusable region under the live gaze: the body
  # panes from the placed tree (via `Lens.pane_regions/3`), plus the cells overlay
  # when its flag is set. Reuses the exact render geometry (resolve_holes →
  # layout) so a region's position here matches where it is actually drawn.
  # Best-effort: a layout failure yields the panes it could place (never raises
  # into the event loop) — `Lens.pane_regions/3` already carries that guard.
  defp frame_regions(state) do
    area = state.last_area

    data_bag =
      DataBag.build(
        Map.put(state, :composer_hint, hint_for(state)),
        area,
        Map.get(state, :data_cache)
      )

    pane_regions = state |> render_tree() |> Lens.pane_regions(area, data_bag)

    pane_regions ++ cells_region(state, area)
  end

  # The cells drawer as a spatial region (slot "cells"), only when shown. Its rect
  # mirrors `cells_drawer_placements/2` so the leader sees it exactly where it is
  # drawn — the rightmost column.
  defp cells_region(state, area) do
    if Map.get(state.ui.flags, "cells-drawer", false) and area.width > 0 do
      w = min(34, area.width)
      [{"cells", %Rect{x: max(0, area.width - w), y: 0, width: w, height: area.height}}]
    else
      []
    end
  end

  # ---- store updates ----

  @impl true
  def handle_info({:store_updated, suffix}, state) do
    # PLAN-023 Task C: COALESCE. Accumulate the dirty suffix and arm a one-shot
    # flush timer if none is pending; do NOT reproject inline AND suppress this
    # message's render (`render?: false`) — the runtime auto-renders after every
    # transition, so without this a telemetry burst of N events would still draw N
    # (cheap, but pointless) frames. Only :flush_store reprojects + renders, so a
    # burst collapses to ONE reproject + ONE render. `store_coalesce_ms: 0` flushes
    # on the next mailbox turn.
    {:noreply, arm_store_flush(merge_store_dirty(state, suffix)), render?: false}
  end

  # The coalescing window elapsed — reproject ONCE over every suffix accumulated
  # since the timer armed, then clear the dirty set + timer. `:all` dominates a
  # specific-suffix list (it already forces a full re-projection). A nil dirty
  # (e.g. an immediate reproject cleared it first) is a harmless no-op.
  def handle_info(:flush_store, %{store_dirty: nil} = state) do
    {:noreply, %{state | store_flush_timer: nil}}
  end

  def handle_info(:flush_store, state) do
    fired = state.store_dirty
    state = %{state | store_dirty: nil, store_flush_timer: nil}
    {:noreply, reproject(state, fired)}
  end

  # Mission Task finished — capture the final result. Focus stays on the TREE (set
  # at submit) so the operator keeps exploring the completed run; the detail pane
  # shows whatever is selected. The status line reflects done/failed. The final
  # state must render NOW (not wait on the coalescing window), so this reprojects
  # immediately and clears any pending store-flush so a later :flush_store can't
  # clobber it with stale dirty (PLAN-023 Task C).
  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])

    state
    |> cancel_store_flush()
    |> Map.put(:running?, false)
    |> Map.put(:result, result)
    |> reproject(:all)
    |> then(&{:noreply, &1})
  end

  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state) do
    {:noreply, %{state | running?: false}}
  end

  # A cell's debounce window elapsed: resolve it OFF this process so a slow query
  # never blocks the UI. The Task reads the live forest + gaze + bag NOW (the
  # quiescent state) and sends {:cell_resolved, …} back. Unlinked + result-routed:
  # a crashing resolve cannot take down the App (Cell.Clock.resolve is itself
  # total, but the spawn is defensive).
  #
  # Generation (W3r): each dispatch carries a per-cell monotonic `gen`. The CAS at
  # completion writes only if `gen` is still the cell's CURRENT generation, so when
  # two ticks for the SAME query overlap (e.g. cursor A then B, same debounce
  # window race), the OLDER resolve's result is discarded even though the query
  # matches — the env it computed against is stale. A stale {:cell_tick} that beat
  # Process.cancel_timer to the mailbox is likewise ignored (its gen is behind).
  def handle_info({:cell_tick, name, gen}, state) do
    if gen == Map.get(state.cell_gens, name) do
      env = state.cell_bag || %{}
      ctx = {Store.spans(state.store), state.ui}
      me = self()

      spawn(fn ->
        result = Cell.Clock.resolve(name, env, ctx)
        send(me, {:cell_resolved, name, gen, result})
      end)

      {:noreply, %{state | cell_timers: Map.delete(state.cell_timers, name)}}
    else
      # A superseded tick: a newer arm already bumped the gen. Do nothing (the
      # newer timer owns the resolve), and do NOT touch cell_timers (it holds the
      # newer ref).
      {:noreply, state}
    end
  end

  # A cell resolve finished. Write only if this result is for the cell's CURRENT
  # generation (a stale/superseded resolve is dropped — W3r). On success, CAS the
  # value into the registry (also discarded if the cell was redefined to a
  # different query meanwhile — W2r) and reproject so the bag picks up data/<name>;
  # the re-diff makes a cell-feeds-cell cascade work (bounded by the cycle guard).
  # On :error, mark the cell :failed so it stops being unconditionally dirty (W3r
  # busy-loop): it will re-resolve only when a real dependency changes.
  def handle_info({:cell_resolved, name, gen, result}, state) do
    if gen == Map.get(state.cell_gens, name) do
      case result do
        {:ok, query, value} -> Cell.Registry.put_resolved(name, query, value)
        :error -> Cell.Registry.mark_failed(name)
      end

      {:noreply, reproject(state, :all)}
    else
      {:noreply, state}
    end
  rescue
    _ -> {:noreply, state}
  catch
    :exit, _ -> {:noreply, state}
  end

  # Terminal resized: remember the new area so the cell bag (and its dep-diff)
  # reflects the real frame size — a cell reading data/area then sees true
  # dimensions and a resize dirties area-dependent cells (W3r). Then reproject so
  # the slow clock ticks with the new area.
  def handle_info(%ExRatatui.Event.Resize{width: w, height: h}, state)
      when is_integer(w) and is_integer(h) do
    {:noreply, reproject(%{state | last_area: %Rect{x: 0, y: 0, width: w, height: h}}, :all)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---- effects the resolver delegates back to the App ----

  # app/submit: run the composer's prompt as a mission. Empty composer = no-op.
  defp submit(%{composer: ""} = state), do: {:noreply, state}

  defp submit(state) do
    prompt = state.composer
    on_submit = state.on_submit

    # A fresh mission: clear the prior forest + result so the view reflects this
    # run only, then run it off the App process so telemetry streams in live.
    Store.reset(state.store)
    Task.async(fn -> on_submit.(prompt) end)

    # Back to NORMAL mode and move focus to the TREE so j/k/h/l explore the run as
    # it streams in (the detail pane mirrors the selection) — PLAN-346 W5 flow.
    ui = state.ui |> Ui.mode(:normal) |> Ui.focus(:tree)

    {:noreply,
     reproject(
       %{state | composer: "", running?: true, result: nil, last_prompt: prompt, ui: ui},
       :all
     )}
  end

  # The composer text sink: backspace edits, a single printable char appends, and
  # anything else is ignored. This is where `:unbound` chords land.
  defp compose(%Chord{key: "backspace"}, state) do
    %{state | composer: String.slice(state.composer, 0..-2//1)}
  end

  # A single printable char appends. Shift is the ONLY modifier allowed here:
  # crossterm folds shift into the `code` ("A", "!"), so a shifted letter arrives
  # as a printable with mods [:shift] — it must still type. ctrl/alt-printables are
  # NOT text (they're chords); they reach compose only when unbound, and are
  # dropped rather than inserted as a stray glyph.
  defp compose(%Chord{key: <<_::utf8>> = ch, mods: mods}, state) when mods in [[], [:shift]] do
    %{state | composer: state.composer <> ch}
  end

  defp compose(_chord, state), do: state

  # ---- store-update coalescing (PLAN-023 Task C) ----

  # Merge a newly-seen {:store_updated} suffix into the accumulated dirty set.
  # `:all` dominates (it already forces a full reproject); otherwise the suffix is
  # accumulated into a deduped list `reproject/2` accepts. nil dirty starts a list.
  defp merge_store_dirty(%{store_dirty: :all} = state, _suffix), do: state
  defp merge_store_dirty(state, :all), do: %{state | store_dirty: :all}

  defp merge_store_dirty(%{store_dirty: nil} = state, suffix),
    do: %{state | store_dirty: [suffix]}

  defp merge_store_dirty(%{store_dirty: list} = state, suffix) when is_list(list) do
    if suffix in list, do: state, else: %{state | store_dirty: [suffix | list]}
  end

  # Arm the one-shot :flush_store timer iff none is pending (a single in-flight
  # timer owns the window; later updates only accumulate dirty). A 0ms window
  # still defers to the next mailbox turn, so a synchronous burst coalesces.
  defp arm_store_flush(%{store_flush_timer: ref} = state) when is_reference(ref), do: state

  defp arm_store_flush(state) do
    ref = Process.send_after(self(), :flush_store, state.store_coalesce_ms)
    %{state | store_flush_timer: ref}
  end

  # Cancel a pending flush and drop the accumulated dirty — used when an immediate
  # reproject (mission completion) already covers every pending update, so a later
  # :flush_store must not clobber the fresh state with stale dirty.
  defp cancel_store_flush(%{store_flush_timer: ref} = state) when is_reference(ref) do
    Process.cancel_timer(ref)
    %{state | store_flush_timer: nil, store_dirty: nil}
  end

  defp cancel_store_flush(state), do: %{state | store_dirty: nil}

  defp reproject(state, fired) do
    forest = Store.spans(state.store)
    # FEAT-038: compute the RADIUS of this batch's change — the root-paths of the
    # spans that differ from the last reprojected forest — so a pane that opts into
    # project_incremental/3 recomputes only affected subtrees. First reproject
    # (no prior forest) or a navigation batch passes :all (recompute everything).
    dirty_paths =
      case Map.get(state, :last_forest) do
        prev when is_map(prev) and fired != :all -> ForestDiff.dirty_paths(prev, forest)
        _ -> :all
      end
    # Inject the live gaze into each pane's projection assigns so a gaze-aware
    # projection (SpanTree, which prunes collapsed subtrees — D4) sees the current
    # collapse/cursor state. Navigation reprojects with :all, so this stays fresh.
    # Inject the gaze + the durable history binding (PLAN-003 SEAM 3) so the
    # History pane's project/2 can reconstitute the conversation from the store.
    hist_assigns = %{ui: state.ui, hist_session: state.hist_session, hist_store: state.hist_store}
    panes = Enum.map(state.panes, fn p -> %{p | assigns: Map.merge(p.assigns, hist_assigns)} end)
    vms = Projection.reconcile(forest, panes, fired, state.vms, dirty_paths)
    # PLAN-023 Task A: recompute the sanitized forest snapshot HERE (the single
    # chokepoint for every forest/vms change) reusing the `forest` already read
    # above — NO extra Store.spans round-trip. Every subsequent keystroke render
    # reuses this cache, so the O(forest) Sanitize.term is paid once per store
    # update / nav, not once per frame.
    data_cache = DataBag.snapshot_from(forest, vms)
    # Retain this forest so the NEXT reproject can diff against it for the radius
    # hint (FEAT-038). Cheap: it is the same map Store.spans already returned.
    # FUP-030 / PLAN-027 M0: resolve every REGISTERED query-clock data source into
    # a plain `%{name => value}` map, HERE on the query clock (a reproject), never
    # on the frame clock — a per-keystroke cross-cutting read would regress the
    # PLAN-023 keystroke-cost invariant. The render loop names NO specific source
    # (no "sessions", no `Cockpit`): it hands each registered producer a read-only
    # context and caches whatever they return. `DataSource.Registry.resolve_all/1`
    # is bounded + per-producer best-effort, so a sick source is omitted, never a
    # raise. `DataBag.build/3` merges the cache as heavy members, under the core
    # keys. The multi-session cockpit's `data/sessions` is ONE such registered
    # source (see `SpellAgent.Tui.Cockpit.install/0`), not a name this loop knows.
    # LAST-GOOD merge (review Sβ P2): resolve_all/1 returns ONLY the sources that
    # succeeded THIS reproject; a source that raised is omitted from that map. If
    # we replaced `data_sources` outright, a transient producer failure would
    # yank an already-good `data/<name>` from every frame until a later success.
    # Instead merge the fresh results OVER the prior cache, so a momentarily-sick
    # source keeps showing its last-good value — the never-brick ladder's
    # last-good rung, held at the App layer where the cross-reproject state lives.
    fresh_sources =
      DataSource.Registry.resolve_all(%{
        hist_store: state.hist_store,
        hist_session: state.hist_session,
        store: state.store,
        ui: state.ui,
        forest: forest
      })

    data_sources = Map.merge(Map.get(state, :data_sources, %{}), fresh_sources)

    state =
      state
      |> Map.put(:vms, vms)
      |> Map.put(:data_cache, data_cache)
      |> Map.put(:data_sources, data_sources)
      |> Map.put(:last_forest, forest)
    # Keep the canonical layout tree's gaze tags in step with state.ui (PLAN-009):
    # fold the current gaze into the LayoutRegistry tree so the agent's lens/ +
    # layout/show see the live focus/cursor, and any slot shadow it authored
    # persists across navigation. Single chokepoint: every gaze/forest change
    # flows through reproject. Best-effort (no registry in a headless test).
    sync_layout_gaze(state.ui)
    sync_hole_affordances(state)
    tick_cells(state)
  end

  # ---- reactive cells: the SLOW clock (PROJ-004 W3) ----
  #
  # reproject/2 is the chokepoint for every gaze/forest/store change — a keystroke
  # or a streamed span, NOT a frame. So it is the right clock for reactive cells:
  # build the current data/* bag, diff it against the last one, and for each cell
  # whose deps changed, ARM a debounce timer. The actual resolve happens off this
  # process (a Task, fired by the timer) so the slow clock never blocks on a query
  # either. Looking never acts on the frame clock; it acts here, debounced, once.
  defp tick_cells(state) do
    bag = cell_bag(state)
    dirty = Cell.Clock.dirty(state.cell_bag, bag)
    state = Enum.reduce(dirty, %{state | cell_bag: bag}, &arm_cell_timer/2)
    state
  rescue
    # A down cell registry (headless test) or any clock error must never break
    # reproject — the UI degrades to no cells, never a crash.
    _ -> state
  catch
    :exit, _ -> state
  end

  # The data/* bag used for cell dep-diffing. Uses the last known frame area (W3r:
  # a zero rect would make a cell reading data/area see zeros and never re-trigger
  # on resize). The render path still builds its own true-area bag for holes.
  defp cell_bag(state) do
    DataBag.build(
      Map.put(state, :composer_hint, hint_for(state)),
      state.last_area,
      Map.get(state, :data_cache)
    )
  end

  # Arm (or re-arm) a debounce timer for one dirty cell: cancel any pending timer
  # for it (coalesce a fast-moving dependency, e.g. a cursor sweep, into a single
  # resolve at quiescence), BUMP the cell's dispatch generation, and schedule a
  # fresh {:cell_tick, name, gen}. The bumped gen makes any in-flight resolve OR an
  # already-mailboxed stale tick from a superseded timer a no-op at completion
  # (W3r): only the newest dispatch's result can land. Returns the updated state.
  defp arm_cell_timer(name, state) do
    case Map.get(state.cell_timers, name) do
      nil -> :ok
      ref -> Process.cancel_timer(ref)
    end

    debounce =
      case Cell.Registry.get(name) do
        %{debounce: ms} -> ms
        _ -> Cell.Registry.default_debounce_ms()
      end

    gen = Map.get(state.cell_gens, name, 0) + 1
    ref = Process.send_after(self(), {:cell_tick, name, gen}, debounce)

    %{
      state
      | cell_timers: Map.put(state.cell_timers, name, ref),
        cell_gens: Map.put(state.cell_gens, name, gen)
    }
  end

  defp sync_layout_gaze(ui) do
    LayoutRegistry.replace(Lens.from_ui(LayoutRegistry.tree(), ui))
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  # ---- hole affordances (PLAN-024 Wave 3, FEAT-020) ----
  #
  # @hole_affordance_context is defined near the module's other attributes
  # (top of file) since Elixir requires an attribute in scope BEFORE its first
  # textual use (focus_stack/1, above).

  @doc false
  @spec hole_affordance_context() :: :hole_affordance
  def hole_affordance_context, do: @hole_affordance_context

  # Re-derive the live hole-affordance bindings/reactions from the CURRENTLY
  # FOCUSED node's declaration and write them into KeymapRegistry — called from
  # reproject/2 (the single gaze/tree-change chokepoint), so a slot's
  # affordances stay in lockstep with navigation: focus a fillable node ->
  # its chords become live; move away -> they tear down (no dangling chords,
  # FEAT-020's own edge case). Idempotent: re-syncing an unchanged slot is a
  # harmless no-op rewrite. Best-effort (registry absent in a headless test
  # degrades to a no-op, matching sync_layout_gaze's posture).
  defp sync_hole_affordances(state) do
    KeymapRegistry.clear_context(@hole_affordance_context)

    case focused_affordance(state) do
      nil ->
        :ok

      slot ->
        {bindings, reactions} = HoleAffordance.generate(slot)
        install_hole_affordances(bindings, reactions)
    end
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  # The `tags["affordance"]` declaration on the currently-focused pane/widget
  # node in the LIVE layout tree, or `nil` if none/not focused/no registry.
  defp focused_affordance(state) do
    tree = render_tree(state)

    case Lens.focused(tree) do
      nil -> nil
      node -> Lens.tags(node)["affordance"]
    end
  end

  # Each generated binding/reaction pair is written into the registry under
  # @hole_affordance_context; KeymapRegistry.bind/put_reaction already handle
  # Chord.parse + the atom-safety of a PRE-BOUNDED intent (HoleAffordance only
  # ever emits atoms from its own compiled pool, never a fresh one), so no
  # additional guard is needed here.
  defp install_hole_affordances(bindings, reactions) do
    for {intent, source} <- reactions do
      KeymapRegistry.put_reaction(@hole_affordance_context, intent, source)
    end

    for {chord_str, intent} <- bindings do
      KeymapRegistry.bind(@hole_affordance_context, Chord.parse(chord_str), intent)
    end
  end

  # ---- widget materialization ----


  # ---- status (one line) ----

  # A single-line run summary across the top: running with counts, or the
  # outcome glyph once done. The FULL answer lives in the scrollable answer pane.
  # ---- composer hint (keymap-derived projection, feeds data/composer-text) ----

  # The hint line is DERIVED from the live keymaps (PLAN-346 W4), focus-aware, so
  # it never drifts from the actual bindings — and a runtime `keymap/bind` is
  # reflected immediately. We show the chord currently bound to a few headline
  # intents in the focused context, then the global ones.
  # Compute the focused pane's keymap context, then delegate the hint composition
  # + chord resolution to SpellAgent.Tui.HintBar (FEAT-041 extraction). Load-safe
  # context-name (BUG-006): function_exported?/3 is false for an unloaded module,
  # so resolve via Keys.context_name (which ensure_loads first).
  defp hint_for(state) do
    [focused | _] = focus_stack(state)
    ctx = Keys.context_name(focused)
    HintBar.render(state.ui.focus, ctx)
  end

  # SEAM 4 (default submit): drive a real mission, threading the App's durable
  # session id so each run APPENDS to one conversation instead of a fresh one.
  defp default_submit(prompt, session_id, store) do
    SpellAgent.Session.run(prompt, session_id: session_id, hist: store)
  end

  # SEAM 4 helper: the most-recently-recorded session id, or a fresh one. Tolerant
  # of a store that is down/empty (history is a best-effort enhancement, never a
  # boot dependency) — any failure yields a new id.
  defp resume_session_id(store) do
    try do
      case Hist.latest(store: store) do
        %{id: id} -> id
        _ -> Hist.new_session_id()
      end
    rescue
      _ -> Hist.new_session_id()
    catch
      _, _ -> Hist.new_session_id()
    end
  end
end
