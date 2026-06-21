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

  alias ExRatatui.Layout.Rect
  alias ExRatatui.Style
  alias ExRatatui.Widgets.{Block, List, Paragraph}
  alias SpellAgent.Hist

  alias SpellAgent.Tui.{
    Chord,
    DefaultLayout,
    Keys,
    Lens,
    LayoutRegistry,
    Materialize,
    Projection,
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
          Ui.new(focus: :prompt, mode: :normal, panes: [:prompt, :history, :tree, :detail])
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

  # The render mirror (PLAN-009): ONE path. Build the layout TREE from the active
  # panes + the live gaze, walk it (`Surface.layout`), and resolve each placed
  # node — a native `"pane"` node through the existing project/view/materialize
  # machinery, the status/composer widget leaves with their dynamic content filled
  # from live run state. The agent can shadow any slot in `LayoutRegistry`; when it
  # has, that subtree is used in place of the native default (same walk).
  #
  # The result order is [status, panes-in-tree-order, composer] — preserved by the
  # tree's structure (status first child, body panes, composer last).
  @impl true
  def render(state, frame) do
    area = %Rect{x: 0, y: 0, width: frame.width, height: frame.height}
    tree = render_tree(state)

    tree
    |> Surface.layout(area)
    |> Enum.flat_map(fn {node, rect} -> resolve_node(node, rect, state) end)
    |> Enum.filter(&encodable_placement?/1)
  end

  # Belt-and-braces (BUG-008): the LayoutRegistry probes AGENT shadows at set-time,
  # but native pane content (project/view/materialize) is never probed, and a deep
  # nested widget can still carry a value the Bridge rejects. ExRatatui.draw encodes
  # ALL placements in one pass, so a SINGLE unencodable widget raises and the WHOLE
  # frame is dropped -- a black/frozen screen. Drop just the offending placement
  # instead: one missing widget is always better than no frame.
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

  # The LayoutRegistry's tree, but only when its BODY pane SLOTS match the App's
  # current panes (so a 2-pane test never picks up a 3-pane live tree, and the
  # registry being absent in a headless test degrades to the native default).
  #
  # We gate on `body_pane_slots/1`, the STABLE slot identities, NOT `focusables/1`:
  # when the agent shadows a pane slot (e.g. `detail`) with a custom widget the
  # node keeps its slot but loses `type: "pane"`, so it falls out of `focusables`.
  # Gating on focusables there made the set shrink, the equality fail, and the
  # whole agent tree silently un-adopt -- the "layout/set ran but nothing changed"
  # bug (BUG-007). The slot identity is the right invariant: it answers "is this
  # the tree for THESE panes" without caring whether a pane was reshaped.
  defp live_layout_tree(pane_names) do
    tree = LayoutRegistry.tree()
    if Lens.body_pane_slots(tree) == pane_names, do: tree
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
  # shadowed the slot with its own content (a widget leaf carrying :text), that
  # wins — the shadow is the whole point. `native_placeholder?/1` distinguishes:
  # the default node has no "text"; an agent paragraph does.
  defp resolve_node(node, rect, state) do
    case Lens.slot(node) do
      "status" -> resolve_filled(node, rect, state, &status_widget/1)
      "composer" -> resolve_filled(node, rect, state, &composer_widget/1)
      _ -> resolve_by_type(node, rect, state)
    end
  end

  defp resolve_filled(node, rect, state, native_fill) do
    if native_placeholder?(node) do
      [{native_fill.(state), rect}]
    else
      resolve_by_type(node, rect, state)
    end
  end

  # The native status/composer placeholders carry no content key; an agent shadow
  # does (e.g. a paragraph with :text, or any non-paragraph widget).
  defp native_placeholder?(node) do
    Map.get(node, "type") in ["paragraph", nil] and
      is_nil(Map.get(node, "text")) and is_nil(Map.get(node, :text))
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
  @impl true
  def handle_event(%ExRatatui.Event.Key{kind: kind} = key, %{ui: %Ui{mode: :insert}} = state)
      when kind in ["press", "repeat"] do
    chord = Chord.from_event(key)

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

  def handle_event(%ExRatatui.Event.Key{kind: kind} = key, %{ui: %Ui{mode: :normal}} = state)
      when kind in ["press", "repeat"] do
    chord = Chord.from_event(key)

    case Keys.resolve(chord, focus_stack(state)) do
      {:intent, :"app/quit", _ctx} ->
        {:stop, state}

      {:intent, :"mode/insert", _ctx} ->
        # Enter INSERT — only meaningful on the prompt; focus it so typing is
        # visibly directed there.
        {:noreply, %{state | ui: state.ui |> Ui.focus(:prompt) |> Ui.mode(:insert)}}

      {:intent, :"app/submit", _ctx} ->
        # `enter` on a non-prompt pane (where mode/insert isn't bound) runs the
        # current composer buffer directly.
        submit(state)

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

  def handle_event(_event, state), do: {:noreply, state}

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
    %{state | vms: vms}
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
      block: %Block{title: " #{desc.title} ", borders: [:all], border_type: :rounded},
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
      block: %Block{title: " #{desc.title}#{focus_tag} ", borders: [:all], border_type: :rounded}
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
      block: %Block{title: " history#{focus_tag} ", borders: [:all], border_type: :rounded}
    }

    {widget, rect}
  end

  defp materialize({widget, rect}, _state), do: {widget, rect}

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
  defp status_widget(state) do
    spans = Store.spans(state.store)
    runs = Store.run_spans(spans)
    tools = length(Store.tool_spans(spans))
    turns = runs |> Enum.flat_map(& &1.turns) |> length()

    {label, color} =
      cond do
        state.running? -> {"● running…  turns #{turns} · tools #{tools}", :yellow}
        match?({:ok, _}, state.result) -> {"✓ done  turns #{turns} · tools #{tools}", :green}
        match?({:error, _}, state.result) -> {"✗ failed  turns #{turns} · tools #{tools}", :red}
        state.result != nil -> {"✓ done  turns #{turns} · tools #{tools}", :green}
        true -> {"idle — type a prompt below, then ↵", :dark_gray}
      end

    %Paragraph{
      text: label,
      style: %Style{fg: color, modifiers: [:bold]},
      block: %Block{title: " spell · inspector ", borders: [:all], border_type: :rounded}
    }
  end

  # ---- composer ----

  defp composer_widget(state) do
    insert? = state.ui.mode == :insert
    # Title carries the modal indicator so the mode is always visible.
    title = if insert?, do: " prompt — INSERT ", else: " prompt — NORMAL "

    text =
      cond do
        # In INSERT, show the live buffer + cursor (always, even when empty).
        insert? -> state.composer <> "▎"
        # In NORMAL with a buffer, show it (un-submitted); else the keymap hint.
        state.composer != "" -> state.composer
        true -> hint_for(state)
      end

    fg = if insert? or state.composer != "", do: :white, else: :dark_gray

    %Paragraph{
      text: text,
      style: %Style{fg: fg},
      block: %Block{title: title, borders: [:all], border_type: :rounded}
    }
  end

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
