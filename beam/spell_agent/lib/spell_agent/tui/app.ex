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
      last_prompt: nil
    }

    {:ok, reproject(state, :all)}
  end

  # ---- render ----

  @impl true
  def render(state, frame) do
    area = %Rect{x: 0, y: 0, width: frame.width, height: frame.height}

    # header (status + final answer, wraps) · body (span tree) · composer (input)
    [header, body, composer] =
      Layout.split(area, :vertical, [{:length, 5}, {:min, 0}, {:length, 3}])

    pane_widgets =
      state.panes
      |> Enum.flat_map(fn pane ->
        vm = Map.get(state.vms, pane.name)
        focused? = true

        pane.module.view(%{vm: vm, rect: body, assigns: pane.assigns, focused?: focused?})
      end)
      |> Enum.map(&materialize(&1, state))

    [{header_widget(state), header} | pane_widgets] ++ [{composer_widget(state), composer}]
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

  # Mission Task finished — capture its final answer and force a final reproject
  # so the header shows the result (D2).
  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, reproject(%{state | running?: false, result: result}, :all)}
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

  defp handle_key("backspace", state) do
    {:noreply, %{state | composer: String.slice(state.composer, 0..-2//1)}}
  end

  defp handle_key("up", state), do: {:noreply, move_cursor(state, -1)}
  defp handle_key("down", state), do: {:noreply, move_cursor(state, +1)}

  # A single printable character.
  defp handle_key(<<_::utf8>> = ch, state) do
    {:noreply, %{state | composer: state.composer <> ch}}
  end

  defp handle_key(_other, state), do: {:noreply, state}

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

  # ---- header (status + final answer) ----

  # A one-line summary of the active run plus the final answer once it lands (D3).
  defp header_widget(state) do
    spans = Store.spans(state.store)
    runs = Store.run_spans(spans)
    tools = length(Store.tool_spans(spans))
    turns = runs |> Enum.flat_map(& &1.turns) |> length()

    {label, color} =
      cond do
        state.running? -> {"● running…  turns #{turns} · tools #{tools}", :yellow}
        state.result -> result_summary(state.result)
        true -> {"idle — type a prompt below, then ↵", :dark_gray}
      end

    %Paragraph{
      text: label,
      wrap: true,
      style: %Style{fg: color, modifiers: [:bold]},
      block: %Block{title: " spell · inspector ", borders: [:all], border_type: :rounded}
    }
  end

  defp result_summary({:ok, answer}), do: {"✓ " <> to_text(answer), :green}
  defp result_summary({:error, reason}), do: {"✗ error: " <> to_text(reason), :red}
  defp result_summary(other), do: {"✓ " <> to_text(other), :green}

  defp to_text(v) when is_binary(v), do: v
  defp to_text(v), do: inspect(v, pretty: false, limit: 8)

  # ---- composer ----

  defp composer_widget(state) do
    {title, hint} =
      if state.running?,
        do: {" running… ", ""},
        else: {" prompt ", "↵ run · ↑↓ scroll · esc quit"}

    text = if state.composer == "", do: hint, else: state.composer <> "▎"

    %Paragraph{
      text: text,
      style: %Style{fg: if(state.composer == "", do: :dark_gray, else: :white)},
      block: %Block{title: title, borders: [:all], border_type: :rounded}
    }
  end

  defp default_submit(prompt), do: SpellAgent.Session.run(prompt)
end
