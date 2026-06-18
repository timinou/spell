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

  alias ExRatatui.Layout
  alias ExRatatui.Layout.Rect
  alias ExRatatui.Style
  alias ExRatatui.Widgets.{Block, List, Paragraph}
  alias SpellAgent.Tui.{Chord, Keys, Projection, Store, Ui}
  alias SpellAgent.Tui.Keymap.{Global, TurnNav}
  alias SpellAgent.Tui.Panes.SpanTree

  @default_panes [%{name: :tree, module: SpanTree, assigns: %{}}]

  # ---- mount ----

  @impl true
  def mount(opts) do
    store = opts[:store] || Store
    Store.attach(store)
    Store.subscribe(store)

    state = %{
      store: store,
      panes: opts[:panes] || @default_panes,
      vms: %{},
      composer: "",
      on_submit: opts[:on_submit] || (&default_submit/1),
      running?: false,
      result: nil,
      last_prompt: nil,
      # The serializable gaze (PLAN-346) — ALL navigation state: focus ring,
      # per-pane cursors, span collapse overrides, turn index, scroll. Replaces
      # the old scattered focus/answer_scroll/assigns.cursor. Default focus is the
      # answer pane so a finished run reads immediately; the ring is
      # answer ↔ tree ↔ prompt under C-j/C-k.
      ui: opts[:ui] || Ui.new(focus: :answer, panes: [:answer, :tree, :prompt])
    }

    {:ok, reproject(state, :all)}
  end

  # The resolver context stack for the current focus (PLAN-346): the focused
  # pane's context FIRST, then the global layer. The SAME chord (C-l/C-h) resolves
  # differently by which context tops the stack — SpanTree (expand/contract) under
  # tree focus, TurnNav (turn next/prev + scroll) under answer/prompt focus.
  defp focus_stack(%{ui: %Ui{focus: :tree}}), do: [SpanTree, Global]
  defp focus_stack(%{ui: %Ui{focus: f}}) when f in [:answer, :prompt], do: [TurnNav, Global]
  defp focus_stack(_), do: [Global]

  # ---- render ----

  @impl true
  def render(state, frame) do
    area = %Rect{x: 0, y: 0, width: frame.width, height: frame.height}

    # status (1 line) · body (answer | span tree) · composer (input)
    [status, body, composer] =
      Layout.split(area, :vertical, [{:length, 3}, {:min, 0}, {:length, 3}])

    # Answer on the left (scrollable, wrapped), span tree on the right. Both
    # take the FULL body height and scroll independently, so everything is
    # reachable regardless of how tall the terminal is.
    [answer_rect, tree_rect] =
      Layout.split(body, :horizontal, [{:percentage, 50}, {:percentage, 50}])

    tree_widgets =
      state.panes
      |> Enum.flat_map(fn pane ->
        vm = Map.get(state.vms, pane.name)
        focused? = state.ui.focus == pane.name
        # The view needs the cursor + gaze: pass ui plus the focused pane's cursor
        # so the highlighted row + collapse glyphs match what the resolver acts on.
        assigns = Map.merge(pane.assigns, %{ui: state.ui, cursor: Ui.cursor_of(state.ui, pane.name)})
        pane.module.view(%{vm: vm, rect: tree_rect, assigns: assigns, focused?: focused?})
      end)
      |> Enum.map(&materialize(&1, state))

    [{status_widget(state), status}, {answer_widget(state), answer_rect}] ++
      tree_widgets ++ [{composer_widget(state), composer}]
  end

  # ---- events: the Reaction DSL resolver path (PLAN-346) ----

  # Every key press becomes a %Chord{} and resolves against the focus context
  # stack. The cascade decides the verb; the App only handles the two effects a
  # pure Ui->Ui reaction cannot express (quit, submit). Composer text editing
  # (enter/backspace/printables) is the LOWEST-priority sink: a chord that no
  # context binds (`:unbound`) falls here, so typing into the prompt still works.
  @impl true
  def handle_event(%ExRatatui.Event.Key{kind: kind} = key, state)
      when kind in ["press", "repeat"] do
    chord = Chord.from_event(key)

    case Keys.resolve(chord, focus_stack(state)) do
      {:intent, :"app/quit", _ctx} ->
        {:stop, state}

      {:intent, :"app/submit", _ctx} ->
        submit(state)

      {:intent, _intent, _ctx} = resolution ->
        forest = Store.spans(state.store)
        ui = Keys.dispatch(resolution, state.ui, forest)
        # Navigation changed the gaze → re-mirror every pane (cheap; the gaze
        # feeds projection now that collapse/cursor live in Ui).
        {:noreply, reproject(%{state | ui: ui}, :all)}

      :unbound ->
        {:noreply, compose(chord, state)}
    end
  end

  def handle_event(_event, state), do: {:noreply, state}

  # ---- store updates ----

  @impl true
  def handle_info({:store_updated, suffix}, state) do
    {:noreply, reproject(state, [suffix])}
  end

  # Mission Task finished — capture its final answer, focus the answer pane and
  # reset its scroll so the start of the answer is visible immediately.
  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    ui = %{state.ui | focus: :answer} |> Map.update!(:scroll, &Map.put(&1, :answer, 0))
    {:noreply, reproject(%{state | running?: false, result: result, ui: ui}, :all)}
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

    {:noreply,
     reproject(%{state | composer: "", running?: true, result: nil, last_prompt: prompt}, :all)}
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
    panes = Enum.map(state.panes, fn p -> %{p | assigns: Map.put(p.assigns, :ui, state.ui)} end)
    vms = Projection.reconcile(forest, panes, fired, state.vms)
    %{state | vms: vms}
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

  # ---- answer (scrollable, wrapped — shows EVERYTHING) ----

  # The full final answer, wrapped to the pane width and vertically scrollable
  # (↑↓ / PgUp·PgDn when focused) so a long response is fully reachable in a
  # fixed-height terminal. While running, shows the latest turn's program/result
  # so there is always something live to read.
  defp answer_widget(state) do
    {body, color} =
      cond do
        state.result != nil -> answer_body(state.result)
        state.running? -> {live_preview(state), :yellow}
        true -> {"(the model's answer will appear here)", :dark_gray}
      end

    focus_tag = if state.ui.focus == :answer, do: " ●", else: ""

    %Paragraph{
      text: body,
      wrap: true,
      scroll: {Ui.scroll_of(state.ui, :answer), 0},
      style: %Style{fg: color},
      block: %Block{title: " answer" <> focus_tag <> " ", borders: [:all], border_type: :rounded}
    }
  end

  defp answer_body({:ok, answer}), do: {to_text(answer), :white}
  defp answer_body({:error, reason}), do: {"error: " <> to_text(reason), :red}
  defp answer_body(other), do: {to_text(other), :white}

  # Latest turn's program + result, so the answer pane is never blank mid-run.
  defp live_preview(state) do
    state.store
    |> Store.spans()
    |> Store.run_spans()
    |> Enum.flat_map(& &1.turns)
    |> Enum.at(-1)
    |> case do
      %{program: p, result_preview: r} when is_binary(p) ->
        "running…\n\n" <> p <> if(is_binary(r), do: "\n→ " <> r, else: "")

      _ ->
        "running…"
    end
  end

  # Full text — NOT truncated; the answer pane scrolls to show all of it.
  defp to_text(v) when is_binary(v), do: v
  defp to_text(v), do: inspect(v, pretty: true, limit: :infinity, printable_limit: :infinity)

  # ---- composer ----

  defp composer_widget(state) do
    {title, hint} =
      if state.running?,
        do: {" running… ", ""},
        else: {" prompt ", hint_for(state)}

    text = if state.composer == "", do: hint, else: state.composer <> "▎"

    %Paragraph{
      text: text,
      style: %Style{fg: if(state.composer == "", do: :dark_gray, else: :white)},
      block: %Block{title: title, borders: [:all], border_type: :rounded}
    }
  end

  # The hint line is DERIVED from the live keymaps (PLAN-346 W4), focus-aware, so
  # it never drifts from the actual bindings — and a runtime `keymap/bind` is
  # reflected immediately. We show the chord currently bound to a few headline
  # intents in the focused context, then the global ones.
  defp hint_for(state) do
    [focused | _] = focus_stack(state)
    ctx = if function_exported?(focused, :context_name, 0), do: focused.context_name(), else: focused

    focused_hints =
      case state.ui.focus do
        :tree -> [chord_hint(ctx, :"span/expand", "expand"), chord_hint(ctx, :"span/contract", "collapse"), chord_hint(ctx, :"cursor/next", "move")]
        f when f in [:answer, :prompt] -> [chord_hint(ctx, :"turn/next", "next turn"), chord_hint(ctx, :"scroll/down", "scroll")]
        _ -> []
      end

    global = [chord_hint(:global, :"focus/next", "pane"), chord_hint(:global, :"app/submit", "run"), chord_hint(:global, :"app/quit", "quit")]

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
  defp compiled_chord_for(_other, _intent), do: nil

  defp keymap_chord(keymap, intent), do: Enum.find_value(keymap, fn {c, i} -> if i == intent, do: c end)

  defp default_submit(prompt), do: SpellAgent.Session.run(prompt)
end
