defmodule SpellAgent.Tui.Panes.SpanTree do
  @moduledoc """
  The span-forest pane (PLAN-345 spike) — the heart of "see everything inside,
  and inside the insides".

  COLOCATION in one module:
    * `events/0`  — wakes on any span open/close + turn boundary.
    * `project/2` — folds the forest into a flat, depth-ordered list of rows
                    (`%{depth, span, turn}`), expanding each run's turns inline
                    under it. This is PURE (forest -> rows) ⇒ unit-tested with no
                    NIF and no terminal.
    * `view/1`    — renders the rows as an ExRatatui `List`, marking the row under
                    the pane cursor (`assigns.cursor`). Widget construction is
                    deferred to the App layer so this module stays NIF-free and
                    testable; `view/1` returns descriptor rows the App turns into
                    a `List` widget.

  The cursor row's span id is exported via `selected_id/2` so a sibling detail
  pane can `mirror :span, from: {:selected, :tree}` (PLAN-345 full design).
  """

  use SpellAgent.Tui.Pane

  alias SpellAgent.Tui.Store
  alias SpellAgent.Tui.Store.Span

  events([
    [:run, :start],
    [:run, :stop],
    [:turn, :start],
    [:turn, :stop],
    [:llm, :start],
    [:llm, :stop],
    [:tool, :start],
    [:tool, :stop],
    [:tool, :exception]
  ])

  @type row :: %{depth: non_neg_integer(), span: Span.t() | nil, turn: map() | nil, id: String.t()}

  @impl true
  def project(forest, _assigns) do
    rows =
      forest
      |> Store.roots_from()
      |> Enum.flat_map(&rows_for(forest, &1, 0))

    %{rows: rows, count: length(rows)}
  end

  @impl true
  def view(%{vm: %{rows: rows}, rect: rect, assigns: assigns, focused?: focused?}) do
    cursor = clamp_cursor(assigns[:cursor] || 0, rows)

    lines =
      rows
      |> Enum.with_index()
      |> Enum.map(fn {row, i} -> render_row(row, i == cursor and focused?) end)

    # The App turns this descriptor into an ExRatatui List widget; keeping the
    # widget struct out of here keeps the pane NIF-free and unit-testable.
    [{{:list, %{title: "spans (#{length(rows)})", lines: lines, cursor: cursor, focused?: focused?}}, rect}]
  end

  @doc "Span id under the cursor, for `{:selected, :tree}` mirrors."
  @spec selected_id(map(), non_neg_integer()) :: String.t() | nil
  def selected_id(vm, cursor) do
    rows = vm[:rows] || []
    cursor = clamp_cursor(cursor, rows)

    case Enum.at(rows, cursor) do
      %{id: id} -> id
      _ -> nil
    end
  end

  # ---- pure projection helpers ----

  # A run row, then its turns inline (depth+1), then its child spans (depth+1).
  defp rows_for(forest, %Span{kind: :run, turns: turns} = span, depth) do
    run_row = %{depth: depth, span: span, turn: nil, id: span.id}
    turn_rows = Enum.map(turns, &%{depth: depth + 1, span: span, turn: &1, id: span.id <> "#t#{&1.number}"})
    child_rows = Enum.flat_map(Store.children(forest, span.id), &rows_for(forest, &1, depth + 1))
    [run_row | turn_rows] ++ child_rows
  end

  # Non-run span (llm / tool): the row, then its children (tool -> nested run).
  defp rows_for(forest, %Span{} = span, depth) do
    [%{depth: depth, span: span, turn: nil, id: span.id}
     | Enum.flat_map(Store.children(forest, span.id), &rows_for(forest, &1, depth + 1))]
  end

  defp rows_for(_forest, nil, _depth), do: []

  defp clamp_cursor(_cursor, []), do: 0
  defp clamp_cursor(cursor, rows), do: cursor |> max(0) |> min(length(rows) - 1)

  # ---- row formatting (pure strings; no widget structs) ----

  @doc false
  def render_row(%{depth: depth, turn: turn} = row, selected?) do
    indent = String.duplicate("  ", depth)
    marker = if selected?, do: "▸ ", else: "  "
    %{text: marker <> indent <> label(row), status: status_of(row), turn?: not is_nil(turn)}
  end

  defp label(%{turn: %{number: n, program: prog, status: st}}) do
    "turn #{n} #{status_glyph(st)} #{truncate(prog, 40)}"
  end

  defp label(%{span: %Span{kind: :run} = s}), do: "#{status_glyph(s.status)} #{s.label}#{dur(s)}"
  defp label(%{span: %Span{kind: :llm} = s}), do: "#{status_glyph(s.status)} #{s.label}#{dur(s)}"

  defp label(%{span: %Span{kind: :tool} = s}) do
    "#{status_glyph(s.status)} #{s.label}#{dur(s)}"
  end

  defp dur(%Span{} = s) do
    case Span.duration_ms(s) do
      nil -> ""
      ms -> "  #{ms}ms"
    end
  end

  defp status_of(%{turn: %{status: st}}), do: st
  defp status_of(%{span: %Span{status: st}}), do: st

  defp status_glyph(:ok), do: "✓"
  defp status_glyph(:error), do: "✗"
  defp status_glyph(_), do: "…"

  defp truncate(nil, _), do: ""
  defp truncate(s, n) when is_binary(s) do
    flat = s |> String.replace(~r/\s+/, " ") |> String.trim()
    if String.length(flat) > n, do: String.slice(flat, 0, n - 1) <> "…", else: flat
  end

  defp truncate(other, n), do: truncate(inspect(other), n)
end
