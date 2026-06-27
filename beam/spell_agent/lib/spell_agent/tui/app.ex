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
  alias ExRatatui.Style
  alias ExRatatui.Widgets.{Block, List, Paragraph}
  alias SpellAgent.Hist

  alias SpellAgent.Tui.{
    Cell,
    Chord,
    DataBag,
    DefaultLayout,
    Keys,
    Lens,
    LayoutRegistry,
    Materialize,
    Projection,
    Spatial,
    Store,
    Surface,
    ThemeRegistry,
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

  # The resolver context stack for the current focus (PLAN-346 W5): the focused
  # pane's context FIRST, then the global layer. The SAME chord (h/l) resolves
  # differently by which context tops the stack — SpanTree (tree nav) under tree
  # focus, TurnNav (turn nav + scroll) under detail/prompt focus.
  defp focus_stack(%{ui: %Ui{focus: :tree}}), do: [SpanTree, Global]
  defp focus_stack(%{ui: %Ui{focus: :prompt}}), do: [Prompt, Global]
  defp focus_stack(%{ui: %Ui{focus: :detail}}), do: [TurnNav, Global]
  # History is a scrollable transcript like Detail — j/k/page scroll via TurnNav.
  defp focus_stack(%{ui: %Ui{focus: :history}}), do: [TurnNav, Global]
  defp focus_stack(_), do: [Global]

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
    data_bag = DataBag.build(Map.put(state, :composer_hint, hint_for(state)), area)

    state
    |> render_tree()
    |> Surface.resolve_holes(data_bag)
    |> Surface.layout(area)
    |> Enum.flat_map(fn {node, rect} -> safe_resolve_node(node, rect, state) end)
    |> Enum.filter(&encodable_placement?/1)
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

  # The SINGLE render contract (BUG-009 + BUG-010): every node's resolution is
  # TOTAL. Two failure modes used to escape:
  #
  #   * BUG-010: `resolve_node` (or the pane `view/1` / `Materialize.to_struct`
  #     it calls) RAISES on a malformed node, killing the whole `render/2` — and
  #     because tests call the pure `render/2` directly (no Server `rescue`), the
  #     test blows up with "bad layout"/"bad body" instead of degrading.
  #   * BUG-009: even when resolution succeeds, an unencodable widget raises at
  #     `ExRatatui.draw` time; the Server drops the WHOLE frame (frozen screen).
  #
  # Guard BOTH here: `safe_resolve_node` makes resolution total (a raise -> drop
  # just this node's leaves), and the trailing `encodable_placement?` filter makes
  # the encode total (an unencodable leaf -> dropped, not raised). A malformed
  # node becomes a GAP; the rest of the frame always renders. This holds on the
  # direct `render/2` path AND under the Server, so `render/2` is safe to unit-test.
  defp safe_resolve_node(node, rect, state) do
    resolve_node(node, rect, state)
  rescue
    e ->
      Logger.warning(
        "render: dropped node #{inspect(Lens.slot(node) || Map.get(node, "type"))}: #{Exception.message(e)}"
      )

      []
  catch
    _, _ -> []
  end

  # The encode gate (BUG-008): a placed widget the Bridge cannot encode would make
  # `ExRatatui.draw` raise and drop the frame. Probe each leaf with the SAME call
  # the draw loop makes and drop the offenders — one missing widget always beats
  # no frame.
  defp encodable_placement?({widget, %Rect{} = rect}) do
    ExRatatui.Bridge.encode_command({widget, rect})
    true
  rescue
    _ -> false
  catch
    _, _ -> false
  end

  defp encodable_placement?(_), do: false

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

  # Resolve a placed leaf node to [{widget, rect}].
  #
  # A "pane" node delegates to its pane module's project/view (the existing,
  # tested machinery) with the gaze + cursor injected, then materializes the
  # descriptor. The status/composer slots are widget leaves whose dynamic content
  # we fill here from live state. Anything else is an agent-authored widget leaf
  # routed straight through Materialize (Surface already did that in render/2, but
  # we walk via layout/2 to intercept the native slots, so handle it here too).
  # The native status/composer slots carry only a static frame (no content) in the
  # default tree, so the App fills their dynamic text. But if the AGENT has
  # ONE resolution path (PLAN-012 W5 dogfood): every node — status, composer, an
  # agent shadow, a pane — resolves by its TYPE. The status/composer slots used to
  # be filled by hardcoded `status_widget`/`composer_widget`; now their default
  # nodes carry tmpl:: holes over the data/* bag (DefaultLayout), already resolved
  # by `Surface.resolve_holes` before this point, so they materialize like any
  # widget. The special-case branch (and the two fill fns) are gone.
  defp resolve_node(node, rect, state) do
    resolve_by_type(node, rect, state)
  end

  defp resolve_by_type(node, rect, state) do
    case Map.get(node, "type") do
      "pane" -> resolve_pane(node, rect, state)
      _ -> materialize_widget(node, rect)
    end
  end

  # A native pane node -> run its module's view over the projected vm + gaze.
  defp resolve_pane(node, rect, state) do
    slot = Lens.slot(node)
    name = safe_pane_name(slot)
    mod = DefaultLayout.pane_module(slot)

    if is_nil(name) or is_nil(mod) do
      []
    else
      vm = Map.get(state.vms, name)
      focused? = state.ui.focus == name
      assigns = %{ui: state.ui, cursor: Ui.cursor_of(state.ui, name)}

      %{vm: vm, rect: rect, assigns: assigns, focused?: focused?}
      |> mod.view()
      |> Enum.map(&materialize(&1, state))
    end
  end

  # An agent-authored widget leaf -> Materialize -> %Widget{} (or skip on error).
  defp materialize_widget(node, rect) do
    case Materialize.to_struct(node) do
      {:error, _} -> []
      widget -> [{widget, rect}]
    end
  end

  defp safe_pane_name(slot) when is_binary(slot), do: Ui.safe_pane(slot)
  defp safe_pane_name(_), do: nil

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

  defp handle_key_event(%Chord{} = chord, %{ui: %Ui{mode: :normal}} = state) do
    case Keys.resolve(chord, focus_stack(state)) do
      {:intent, :"app/quit", _ctx} ->
        {:stop, state}

      {:intent, :"frame/leader", _ctx} ->
        # Arm the FRAME leader (C-w): the next key picks a region spatially.
        {:noreply, %{state | pending_leader: true}}

      {:intent, :"mode/insert", _ctx} ->
        # Enter INSERT — only meaningful on the prompt; focus it so typing is
        # visibly directed there.
        {:noreply, %{state | ui: state.ui |> Ui.focus(:prompt) |> Ui.mode(:insert)}}

      {:intent, :"app/submit", _ctx} ->
        # `enter` on a non-prompt pane (where mode/insert isn't bound) runs the
        # current composer buffer directly.
        submit(state)

      {:intent, :"app/reset-layout", _ctx} ->
        reset_layout(state) |> then(&{:noreply, &1})

      {:intent, _intent, _ctx} = resolution ->
        forest = Store.spans(state.store)
        ui = Keys.dispatch(resolution, state.ui, forest)
        # Navigation changed the gaze → re-mirror every pane (the detail pane
        # mirrors the new selection; cheap, gaze-fed projection).
        {:noreply, reproject(%{state | ui: ui}, :all)}

      :unbound ->
        # In NORMAL an unbound key does NOTHING (no stray text — that's INSERT).
        {:noreply, state}
    end
  end

  defp handle_key_event(%Chord{}, state), do: {:noreply, state}

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
  defp frame_target(state, dir) do
    state |> frame_regions() |> Spatial.extreme(dir)
  end

  # `[{slot, %Rect{}}]` for every focusable region under the live gaze: the body
  # panes from the placed tree, plus the cells overlay when its flag is set. Reuses
  # the exact render geometry (resolve_holes → layout) so a region's position here
  # matches where it is actually drawn. Best-effort: a layout failure yields the
  # panes it could place (never raises into the event loop).
  defp frame_regions(state) do
    area = state.last_area
    data_bag = DataBag.build(Map.put(state, :composer_hint, hint_for(state)), area)

    pane_regions =
      state
      |> render_tree()
      |> Surface.resolve_holes(data_bag)
      |> Surface.layout(area)
      |> Enum.flat_map(fn {node, rect} ->
        case Lens.slot(node) do
          slot when is_binary(slot) -> if Ui.safe_pane(slot), do: [{slot, rect}], else: []
          _ -> []
        end
      end)

    pane_regions ++ cells_region(state, area)
  rescue
    _ -> []
  catch
    :exit, _ -> []
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
    {:noreply, reproject(state, [suffix])}
  end

  # Mission Task finished — capture the final result. Focus stays on the TREE (set
  # at submit) so the operator keeps exploring the completed run; the detail pane
  # shows whatever is selected. The status line reflects done/failed.
  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, reproject(%{state | running?: false, result: result}, :all)}
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

  defp reproject(state, fired) do
    forest = Store.spans(state.store)
    # Inject the live gaze into each pane's projection assigns so a gaze-aware
    # projection (SpanTree, which prunes collapsed subtrees — D4) sees the current
    # collapse/cursor state. Navigation reprojects with :all, so this stays fresh.
    # Inject the gaze + the durable history binding (PLAN-003 SEAM 3) so the
    # History pane's project/2 can reconstitute the conversation from the store.
    hist_assigns = %{ui: state.ui, hist_session: state.hist_session, hist_store: state.hist_store}
    panes = Enum.map(state.panes, fn p -> %{p | assigns: Map.merge(p.assigns, hist_assigns)} end)
    vms = Projection.reconcile(forest, panes, fired, state.vms)
    # Keep the canonical layout tree's gaze tags in step with state.ui (PLAN-009):
    # fold the current gaze into the LayoutRegistry tree so the agent's lens/ +
    # layout/show see the live focus/cursor, and any slot shadow it authored
    # persists across navigation. Single chokepoint: every gaze/forest change
    # flows through reproject. Best-effort (no registry in a headless test).
    sync_layout_gaze(state.ui)
    tick_cells(%{state | vms: vms})
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
    DataBag.build(Map.put(state, :composer_hint, hint_for(state)), state.last_area)
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

  # ---- widget materialization ----

  # SpanTree.view returns descriptor rows ({:list, %{…}}) so the pane stays
  # NIF-free + unit-testable; the App turns them into real ExRatatui widgets.
  defp materialize({{:list, desc}, rect}, _state) do
    items = Enum.map(desc.lines, fn line -> style_line(line) end)

    widget = %List{
      items: items,
      block: %Block{title: " #{desc.title} ", borders: [:all], border_type: :rounded, border_style: border_style_for(desc.focused?)},
      highlight_style: %Style{modifiers: [:bold]},
      selected: select_index(desc, length(items))
    }

    {widget, rect}
  end

  # Detail.view returns a {:detail, %{title, body, scroll, focused?}} descriptor;
  # the App turns it into a scrollable, wrapped Paragraph (the "see inside" pane).
  defp materialize({{:detail, desc}, rect}, _state) do
    focus_tag = if desc.focused?, do: " ●", else: ""

    widget = %Paragraph{
      text: desc.body,
      wrap: true,
      scroll: {desc.scroll, 0},
      style: %Style{fg: :white},
      block: %Block{title: " #{desc.title}#{focus_tag} ", borders: [:all], border_type: :rounded, border_style: border_style_for(desc.focused?)}
    }

    {widget, rect}
  end

  # The history pane (PLAN-003 SEAM 3): a durable user<->assistant scrollback,
  # rendered as a scrollable Paragraph (NIF-free, same contract as Detail).
  defp materialize({{:history, desc}, rect}, _state) do
    focus_tag = if desc.focused?, do: " ●", else: ""

    text =
      if desc.empty? do
        "(no history yet — run a mission; it persists across runs and reopen)"
      else
        Enum.map_join(desc.lines, "\n", fn
          %{role: :user, text: t} -> "› you  " <> t
          %{role: :assistant, text: t} -> "‹ agent " <> t
        end)
      end

    widget = %Paragraph{
      text: text,
      wrap: true,
      scroll: {desc.scroll, 0},
      style: %Style{fg: :white},
      block: %Block{title: " history#{focus_tag} ", borders: [:all], border_type: :rounded, border_style: border_style_for(desc.focused?)}
    }

    {widget, rect}
  end

  defp materialize({widget, rect}, _state), do: {widget, rect}

  # Border styling based on focus — uses theme's border_focused color when active
  defp border_style_for(true) do
    theme = ThemeRegistry.theme()
    %Style{fg: theme.border_focused, modifiers: [:bold]}
  end

  defp border_style_for(false) do
    theme = ThemeRegistry.theme()
    %Style{fg: theme.border}
  end

  # `List.selected` MUST be nil or a valid 0-based index; an empty list has no
  # selection (else ExRatatui raises at render).
  defp select_index(_desc, 0), do: nil
  defp select_index(%{focused?: true, cursor: c}, count), do: c |> max(0) |> min(count - 1)
  defp select_index(_desc, _count), do: nil

  defp style_line(%{text: text, status: status}) do
    %ExRatatui.Text.Line{
      spans: [%ExRatatui.Text.Span{content: text, style: %Style{fg: status_color(status)}}]
    }
  end

  defp status_color(:ok), do: :green
  defp status_color(:error), do: :red
  defp status_color(_), do: :yellow

  # ---- status (one line) ----

  # A single-line run summary across the top: running with counts, or the
  # outcome glyph once done. The FULL answer lives in the scrollable answer pane.
  # ---- composer hint (keymap-derived projection, feeds data/composer-text) ----

  # The hint line is DERIVED from the live keymaps (PLAN-346 W4), focus-aware, so
  # it never drifts from the actual bindings — and a runtime `keymap/bind` is
  # reflected immediately. We show the chord currently bound to a few headline
  # intents in the focused context, then the global ones.
  defp hint_for(state) do
    [focused | _] = focus_stack(state)

    # Load-safe context-name (BUG-006): function_exported?/3 is false for an
    # unloaded module, so resolve via Keys.context_name (which ensure_loads first).
    ctx = Keys.context_name(focused)

    focused_hints =
      case state.ui.focus do
        :tree ->
          [
            chord_hint(ctx, :"nav/next", "next"),
            chord_hint(ctx, :"nav/child", "in"),
            chord_hint(ctx, :"nav/parent", "out")
          ]

        :detail ->
          [chord_hint(ctx, :"scroll/down", "scroll")]

        :prompt ->
          [chord_hint(ctx, :"mode/insert", "type")]

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
  # between whereis and the call, crashing the render path (final-review P2). The
  # hint is best-effort, so any failure degrades to compiled-keymap hints.
  defp live_bindings(context) do
    SpellAgent.Tui.KeymapRegistry.bindings(context)
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
