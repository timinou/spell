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
  alias SpellAgent.Tui.{Projection, Store}
  alias SpellAgent.Tui.Panes.SpanTree

  @default_panes [%{name: :tree, module: SpanTree, assigns: %{cursor: 0}}]

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
      # Which pane the scroll keys drive (Tab toggles). The answer + tree each
      # scroll independently so a long answer or a deep forest is fully reachable
      # despite a fixed-height terminal.
      focus: :answer,
      answer_scroll: 0
    }

    {:ok, reproject(state, :all)}
  end

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
        focused? = state.focus == :tree
        pane.module.view(%{vm: vm, rect: tree_rect, assigns: pane.assigns, focused?: focused?})
      end)
      |> Enum.map(&materialize(&1, state))

    [{status_widget(state), status}, {answer_widget(state), answer_rect}] ++
      tree_widgets ++ [{composer_widget(state), composer}]
  end

  # ---- events ----

  @impl true
  def handle_event(%ExRatatui.Event.Key{code: code, kind: kind}, state)
      when kind in ["press", "repeat"] do
    handle_key(code, state)
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

    {:noreply,
     reproject(%{state | running?: false, result: result, focus: :answer, answer_scroll: 0}, :all)}
  end

  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state) do
    {:noreply, %{state | running?: false}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---- key handling ----

  defp handle_key("enter", %{composer: ""} = state), do: {:noreply, state}

  defp handle_key("enter", state) do
    prompt = state.composer
    on_submit = state.on_submit

    # A fresh mission: clear the prior forest + result so the view reflects this
    # run only, then run it off the App process so telemetry streams in live.
    Store.reset(state.store)
    Task.async(fn -> on_submit.(prompt) end)

    {:noreply,
     reproject(%{state | composer: "", running?: true, result: nil, last_prompt: prompt}, :all)}
  end

  # Esc (or Ctrl-C) quits the app and restores the terminal.
  defp handle_key(code, state) when code in ["esc", "ctrl-c"], do: {:stop, state}

  # Tab switches which pane the scroll keys drive.
  defp handle_key("tab", state) do
    {:noreply, %{state | focus: toggle_focus(state.focus)}}
  end

  defp handle_key("backspace", state) do
    {:noreply, %{state | composer: String.slice(state.composer, 0..-2//1)}}
  end

  # Scroll keys act on the focused pane: the answer (text scroll) or the tree
  # (cursor move, which the List auto-scrolls to follow).
  defp handle_key("up", state), do: {:noreply, scroll(state, -1)}
  defp handle_key("down", state), do: {:noreply, scroll(state, +1)}
  defp handle_key("page_up", state), do: {:noreply, scroll(state, -10)}
  defp handle_key("page_down", state), do: {:noreply, scroll(state, +10)}

  # A single printable character.
  defp handle_key(<<_::utf8>> = ch, state) do
    {:noreply, %{state | composer: state.composer <> ch}}
  end

  defp handle_key(_other, state), do: {:noreply, state}

  defp toggle_focus(:answer), do: :tree
  defp toggle_focus(:tree), do: :answer

  defp scroll(%{focus: :answer} = state, delta) do
    %{state | answer_scroll: max((state.answer_scroll || 0) + delta, 0)}
  end

  defp scroll(%{focus: :tree} = state, delta), do: move_cursor(state, delta)

  # ---- cursor / projection ----

  # Move the focused pane's cursor and reproject (so {:selected,…} mirrors and
  # the highlighted row update). Spike: the single tree pane is the focus.
  defp move_cursor(state, delta) do
    panes =
      Enum.map(state.panes, fn
        %{name: :tree, assigns: a} = p ->
          %{p | assigns: Map.update(a, :cursor, 0, &max(&1 + delta, 0))}

        p ->
          p
      end)

    reproject(%{state | panes: panes}, :all)
  end

  defp reproject(state, fired) do
    forest = Store.spans(state.store)
    vms = Projection.reconcile(forest, state.panes, fired, state.vms)
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

    focus_tag = if state.focus == :answer, do: " ●", else: ""

    %Paragraph{
      text: body,
      wrap: true,
      scroll: {state.answer_scroll || 0, 0},
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
        else: {" prompt ", "↵ run · tab switch · ↑↓/pgup·pgdn scroll · esc quit"}

    text = if state.composer == "", do: hint, else: state.composer <> "▎"

    %Paragraph{
      text: text,
      style: %Style{fg: if(state.composer == "", do: :dark_gray, else: :white)},
      block: %Block{title: title, borders: [:all], border_type: :rounded}
    }
  end

  defp default_submit(prompt), do: SpellAgent.Session.run(prompt)
end
