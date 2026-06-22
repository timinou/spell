defmodule SpellAgent.Tui.SessionBrowser do
  @moduledoc """
  A two-pane browser for sessions and their traces (PLAN-010, C6).

  A real `ExRatatui.App` — the same runtime the live inspector and gallery use —
  whose job is read-only: LIST sessions (open + past) and READ the selected
  session's trace. Left pane is the session index (`Hist.SessionList`); right pane
  is the trace of the highlighted session (`Hist.Trace`), with each turn drillable
  into its execution interior.

  ## Why it refreshes

  Open sessions stream: a mission registered as live, and each turn it records,
  should appear without a relaunch. The browser re-reads the list + trace on a
  periodic tick (and on demand with `r`), so "open" sessions and freshly-recorded
  turns surface live. The reads are pure projections over the store + registry, so
  a tick is cheap and never blocks.

  ## Keys

      j / k / ↑ / ↓   move within the focused pane
      l / enter        list: focus the trace · trace: expand the turn's interior
      h                trace: collapse the turn, or return focus to the list
      tab              toggle focus between list and trace
      r                refresh now
      esc / q          quit

  Launch with `mix spell.sessions` (or `start_link/1` from a real terminal). It
  takes over stdin/stdout, so a dedicated task — not iex — is the supported entry
  (BUG-489), exactly like `mix spell.tui` / `mix spell.gallery`.
  """

  use ExRatatui.App

  alias ExRatatui.Layout
  alias ExRatatui.Layout.Rect
  alias ExRatatui.Style
  alias ExRatatui.Widgets.{Block, List, Paragraph}
  alias SpellAgent.Hist
  alias SpellAgent.Hist.Trace
  alias SpellAgent.Tui.SessionView

  # Refresh cadence (ms) — open sessions + new turns appear within this window.
  @refresh_ms 1000

  # ---- mount ----

  @impl true
  def mount(opts) do
    store = opts[:hist_store] || Hist.default_store()
    # Injectable list/interior sources keep the App testable headless: a test
    # passes a fixed store (and optionally a live snapshot) and drives the keys.
    state = %{
      store: store,
      live: opts[:live],
      focus: :list,
      sessions: [],
      list_cursor: 0,
      trace: [],
      trace_cursor: 0,
      expanded: %{},
      refresh_ms: opts[:refresh_ms] || @refresh_ms
    }

    schedule_refresh(state.refresh_ms)
    {:ok, load(state)}
  end

  # ---- data loading (pure reads) ----

  # Re-read the session list, then the trace of whatever session is selected.
  defp load(state) do
    sessions = list_rows(state)
    state = %{state | sessions: sessions, list_cursor: clamp(state.list_cursor, sessions)}
    load_trace(state)
  end

  defp list_rows(state) do
    opts = [store: state.store]
    opts = if state.live, do: Keyword.put(opts, :live, state.live), else: opts
    Hist.SessionList.rows(opts)
  rescue
    _ -> []
  end

  # Load the selected session's trace + the interiors of its expanded turns.
  defp load_trace(state) do
    case current_session(state) do
      nil ->
        %{state | trace: [], trace_cursor: 0, expanded: %{}}

      %{session_id: sid} ->
        rows = safe_trace(state.store, sid)
        # Keep only expansions that still point at a present node, and refresh
        # their interiors from the store (a live turn may have grown).
        expanded =
          state.expanded
          |> Map.take(Enum.map(rows, & &1.node_id))
          |> Map.new(fn {nid, _} -> {nid, Trace.interior_of(state.store, sid, nid)} end)

        %{state | trace: rows, trace_cursor: clamp(state.trace_cursor, rows), expanded: expanded}
    end
  end

  defp safe_trace(store, sid) do
    Hist.Trace.rows(store, sid)
  rescue
    _ -> []
  end

  # ---- render ----

  @impl true
  def render(state, frame) do
    area = %Rect{x: 0, y: 0, width: frame.width, height: frame.height}

    [header, body, footer] =
      Layout.split(area, :vertical, [{:length, 3}, {:min, 0}, {:length, 3}])

    [list_rect, trace_rect] =
      Layout.split(body, :horizontal, [{:percentage, 42}, {:percentage, 58}])

    [
      {header_widget(state), header},
      {list_widget(state), list_rect},
      {trace_widget(state), trace_rect},
      {footer_widget(state), footer}
    ]
  end

  defp header_widget(state) do
    live = Enum.count(state.sessions, & &1.live?)
    total = length(state.sessions)

    %Paragraph{
      text: "spell · sessions   #{total} total · #{live} live",
      style: %Style{fg: :cyan, modifiers: [:bold]},
      block: %Block{title: " sessions ", borders: [:all], border_type: :rounded}
    }
  end

  defp list_widget(state) do
    lines = SessionView.list_lines(state.sessions)
    items = Enum.map(lines, &line_item/1)

    %List{
      items: items,
      block: %Block{title: " index ", borders: [:all], border_type: :rounded},
      highlight_style: %Style{fg: :black, bg: :cyan, modifiers: [:bold]},
      selected: selected(state.focus == :list, state.list_cursor, length(items))
    }
  end

  defp trace_widget(state) do
    lines = SessionView.trace_lines(state.trace, state.expanded)
    items = Enum.map(lines, &line_item/1)
    title = trace_title(state)

    %List{
      items: items,
      block: %Block{title: title, borders: [:all], border_type: :rounded},
      highlight_style: %Style{fg: :black, bg: :cyan, modifiers: [:bold]},
      selected: selected(state.focus == :trace, trace_line_cursor(state, lines), length(items))
    }
  end

  defp footer_widget(state) do
    hint =
      case state.focus do
        :list -> "j/k move · l/↵ open trace · tab switch · r refresh · q quit"
        :trace -> "j/k move · l expand · h collapse/back · tab switch · q quit"
      end

    %Paragraph{
      text: hint,
      style: %Style{fg: :dark_gray},
      block: %Block{borders: [:all], border_type: :rounded}
    }
  end

  # ---- events ----

  @impl true
  def handle_event(%ExRatatui.Event.Key{code: code, kind: kind}, state)
      when kind in ["press", "repeat"] do
    handle_key(code, state)
  end

  def handle_event(_event, state), do: {:noreply, state}

  @impl true
  def handle_info(:refresh, state) do
    schedule_refresh(state.refresh_ms)
    {:noreply, load(state)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # quit
  defp handle_key(code, state) when code in ["q", "esc"], do: {:stop, state}

  # manual refresh
  defp handle_key("r", state), do: {:noreply, load(state)}

  # toggle focus
  defp handle_key("tab", state), do: {:noreply, toggle_focus(state)}

  # movement + drill, dispatched by focused pane
  defp handle_key(code, %{focus: :list} = state) when code in ["down", "j"],
    do: {:noreply, move_list(state, +1)}

  defp handle_key(code, %{focus: :list} = state) when code in ["up", "k"],
    do: {:noreply, move_list(state, -1)}

  defp handle_key(code, %{focus: :list} = state) when code in ["l", "right", "enter"],
    do: {:noreply, %{state | focus: :trace}}

  defp handle_key(code, %{focus: :trace} = state) when code in ["down", "j"],
    do: {:noreply, move_trace(state, +1)}

  defp handle_key(code, %{focus: :trace} = state) when code in ["up", "k"],
    do: {:noreply, move_trace(state, -1)}

  defp handle_key(code, %{focus: :trace} = state) when code in ["l", "right", "enter"],
    do: {:noreply, expand_current(state)}

  defp handle_key(code, %{focus: :trace} = state) when code in ["h", "left"],
    do: {:noreply, collapse_or_back(state)}

  defp handle_key(_code, state), do: {:noreply, state}

  # ---- state transitions ----

  defp toggle_focus(%{focus: :list} = state), do: %{state | focus: :trace}
  defp toggle_focus(%{focus: :trace} = state), do: %{state | focus: :list}

  # Move the list cursor and reload the trace for the newly-selected session.
  defp move_list(state, delta) do
    cursor = clamp_index(state.list_cursor + delta, length(state.sessions))
    %{state | list_cursor: cursor, trace_cursor: 0, expanded: %{}} |> load_trace()
  end

  defp move_trace(state, delta) do
    %{state | trace_cursor: clamp_index(state.trace_cursor + delta, length(state.trace))}
  end

  # Expand the turn under the cursor: fetch + cache its interior. A turn with no
  # interior is a no-op (nothing to drill).
  defp expand_current(state) do
    case current_node(state) do
      %{has_interior?: true, node_id: nid} = _row ->
        case current_session(state) do
          %{session_id: sid} ->
            interior = Trace.interior_of(state.store, sid, nid)
            %{state | expanded: Map.put(state.expanded, nid, interior)}

          _ ->
            state
        end

      _ ->
        state
    end
  end

  # Collapse the cursor turn if expanded; otherwise return focus to the list.
  defp collapse_or_back(state) do
    case current_node(state) do
      %{node_id: nid} ->
        if Map.has_key?(state.expanded, nid) do
          %{state | expanded: Map.delete(state.expanded, nid)}
        else
          %{state | focus: :list}
        end

      _ ->
        %{state | focus: :list}
    end
  end

  # ---- selectors ----

  defp current_session(%{sessions: []}), do: nil
  defp current_session(%{sessions: s, list_cursor: c}), do: Enum.at(s, clamp_index(c, length(s)))

  defp current_node(%{trace: []}), do: nil
  defp current_node(%{trace: t, trace_cursor: c}), do: Enum.at(t, clamp_index(c, length(t)))

  defp trace_title(state) do
    case current_session(state) do
      nil -> " trace "
      %{session_id: sid, live?: live?} -> " trace#{if live?, do: " ● live", else: ""}  #{short(sid)} "
    end
  end

  # The trace cursor indexes NODE rows; the rendered List has extra interior
  # lines. Map the node cursor onto the rendered line index so the highlight
  # lands on the selected turn's head line, not an interior line.
  defp trace_line_cursor(state, _lines) do
    node_ids_before =
      state.trace
      |> Enum.take(clamp_index(state.trace_cursor, length(state.trace)))

    Enum.reduce(node_ids_before, 0, fn row, acc ->
      acc + 1 + interior_count(state, row.node_id)
    end)
  end

  defp interior_count(state, node_id) do
    case Map.get(state.expanded, node_id) do
      spans when is_list(spans) -> length(spans)
      _ -> 0
    end
  end

  # ---- widget helpers ----

  defp line_item(%{text: text, status: status}) do
    %ExRatatui.Text.Line{
      spans: [%ExRatatui.Text.Span{content: text, style: %Style{fg: status_color(status)}}]
    }
  end

  defp selected(_focused?, _cursor, 0), do: nil
  defp selected(true, cursor, count), do: cursor |> max(0) |> min(count - 1)
  defp selected(false, _cursor, _count), do: nil

  defp status_color(:ok), do: :green
  defp status_color(:error), do: :red
  defp status_color(_), do: :white

  defp short(id) when is_binary(id), do: String.slice(id, 0, 16)
  defp short(_), do: "?"

  defp schedule_refresh(ms) when is_integer(ms) and ms > 0,
    do: Process.send_after(self(), :refresh, ms)

  defp schedule_refresh(_), do: :ok

  defp clamp(_cursor, []), do: 0
  defp clamp(cursor, list), do: clamp_index(cursor, length(list))

  defp clamp_index(_i, 0), do: 0
  defp clamp_index(i, count), do: i |> max(0) |> min(count - 1)
end
