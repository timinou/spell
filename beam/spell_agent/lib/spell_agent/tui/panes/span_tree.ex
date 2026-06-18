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
  alias SpellAgent.Tui.Ui

  @doc "This context's registry key (for live `keymap/bind` overrides)."
  @spec context_name() :: :tree
  def context_name, do: :tree

  # The tree's vocabulary (PLAN-346 W5 — vim tree-nav, NORMAL mode):
  #   j / k  move to the next / prev VISIBLE row (sibling-or-cousin as shown)
  #   l      descend INTO the cursor span (expand it + move to its first child)
  #   h      ascend OUT to the cursor span's parent
  # Arrows mirror j/k for discoverability. C-j/C-k (focus ring) fall through to
  # Keymap.Global so they work under every focus. (The detail pane mirrors the
  # cursor, so moving the cursor IS "seeing inside" — the screenshot problem.)
  keymap([
    {"j", :"nav/next"},
    {"k", :"nav/prev"},
    {"l", :"nav/child"},
    {"h", :"nav/parent"},
    {"down", :"nav/next"},
    {"up", :"nav/prev"},
    {"page_up", :"cursor/page-prev"},
    {"page_down", :"cursor/page-next"},
    # explicit expand/collapse stay available on C-l/C-h (secondary to h/l nav).
    {"C-l", :"span/expand"},
    {"C-h", :"span/contract"}
  ])

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
  def project(forest, assigns) do
    ui = assigns_ui(assigns)

    rows =
      forest
      |> Store.roots_from()
      |> Enum.flat_map(&rows_for(forest, &1, 0, ui))

    %{rows: rows, count: length(rows)}
  end

  # The gaze the projection prunes by. A spec without a `:ui` (e.g. the legacy
  # `%{cursor: n}` assigns, or a pure unit test) means "show everything": a gaze
  # with a very large auto_depth and no overrides, so expanded?/3 is always true.
  defp assigns_ui(%{ui: %Ui{} = ui}), do: ui
  defp assigns_ui(_), do: %Ui{auto_depth: 1_000_000, overrides: %{}}

  # ---- reactions (intent -> gaze') ----

  @impl true
  # j/k — move among VISIBLE rows. Clamp to the row count so the cursor never
  # points past the end (which would make cursor_span_id nil).
  def react(:"nav/next", %Ui{} = ui, forest), do: move_cursor(ui, forest, +1)
  def react(:"nav/prev", %Ui{} = ui, forest), do: move_cursor(ui, forest, -1)
  def react(:"cursor/page-next", %Ui{} = ui, forest), do: move_cursor(ui, forest, +10)
  def react(:"cursor/page-prev", %Ui{} = ui, forest), do: move_cursor(ui, forest, -10)

  # l — descend INTO the cursor span: if it has hidden children, expand it (its
  # first child becomes the next visible row); then move the cursor onto that
  # child. If already expanded (or a leaf), just step to the first child row.
  def react(:"nav/child", %Ui{} = ui, forest) do
    case cursor_span_id(forest, ui) do
      nil ->
        ui

      id ->
        ui = if has_children?(forest, id), do: Ui.expand(ui, id), else: ui
        # After expanding, the first child is the row immediately below the parent.
        if has_children?(forest, id), do: move_cursor(ui, forest, +1), else: ui
    end
  end

  # h — ascend OUT to the cursor span's parent: set the cursor to the parent's
  # row. At a root, stay put.
  def react(:"nav/parent", %Ui{} = ui, forest) do
    with id when is_binary(id) <- cursor_span_id(forest, ui),
         %Span{parent_id: pid} when is_binary(pid) <- forest[id],
         row when is_integer(row) <- row_index_of(forest, ui, pid) do
      put_cursor(ui, row)
    else
      _ -> ui
    end
  end

  # explicit expand/collapse (C-l/C-h) — secondary to h/l nav.
  def react(:"span/expand", %Ui{} = ui, forest), do: with_cursor_span(ui, forest, &Ui.expand/2)
  def react(:"span/contract", %Ui{} = ui, forest), do: with_cursor_span(ui, forest, &Ui.collapse/2)
  def react(_intent, %Ui{} = ui, _forest), do: ui

  # Move the tree cursor by `delta`, clamped to [0, last visible row].
  defp move_cursor(%Ui{} = ui, forest, delta) do
    n = row_count(forest, ui)
    cur = Ui.cursor_of(ui, :tree)
    put_cursor(ui, clamp(cur + delta, 0, max(n - 1, 0)))
  end

  defp put_cursor(%Ui{cursors: c} = ui, n), do: %{ui | cursors: Map.put(c, :tree, n)}
  defp clamp(v, lo, hi), do: v |> max(lo) |> min(hi)

  defp has_children?(forest, id), do: Store.children(forest, id) != []

  defp row_count(forest, ui) do
    forest |> Store.roots_from() |> Enum.flat_map(&rows_for(forest, &1, 0, ui)) |> length()
  end

  # The visible-row index of span `id` under the current gaze, or nil if not shown.
  defp row_index_of(forest, ui, id) do
    forest
    |> Store.roots_from()
    |> Enum.flat_map(&rows_for(forest, &1, 0, ui))
    |> Enum.find_index(fn row -> row.id == id end)
  end

  # Apply a collapse/expand transform to the span under the tree cursor. The
  # cursor indexes the ROWS as projected UNDER THE CURRENT GAZE (so the id lines
  # up with what the operator sees), then we hand its span id to the transform.
  defp with_cursor_span(%Ui{} = ui, forest, transform) do
    case cursor_span_id(forest, ui) do
      nil -> ui
      id -> transform.(ui, id)
    end
  end

  @doc """
  The span id under the tree cursor, given the live forest and gaze — the row set
  is projected under `ui` so the index matches what is rendered. Public so the App
  (and `{:selected, :tree}` mirrors) can resolve the selection.
  """
  @spec cursor_span_id(map(), Ui.t()) :: String.t() | nil
  def cursor_span_id(forest, %Ui{} = ui) do
    case selected_row(forest, ui) do
      %{id: id} -> id
      _ -> nil
    end
  end

  @doc """
  The full ROW under the tree cursor (`%{depth, span, turn, id, ...}`) given the
  live forest + gaze — the source the detail pane renders. A run/llm/tool row
  carries its `:span`; a turn row also carries `:turn`. nil on an empty forest.
  """
  @spec selected_row(map(), Ui.t()) :: map() | nil
  def selected_row(forest, %Ui{} = ui) do
    rows =
      forest
      |> Store.roots_from()
      |> Enum.flat_map(&rows_for(forest, &1, 0, ui))

    Enum.at(rows, clamp_cursor(Ui.cursor_of(ui, :tree), rows))
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

  # A run row, then (IF expanded under the gaze) its turns inline (depth+1) and
  # its child spans (depth+1). When collapsed, only the run row shows, flagged so
  # the view can render a ▸ (collapsed) vs ▾ (expanded) glyph (D4).
  defp rows_for(forest, %Span{kind: :run, turns: turns} = span, depth, ui) do
    has_children? = turns != [] or Store.children(forest, span.id) != []

    if Ui.expanded?(ui, depth, span.id) do
      run_row = %{depth: depth, span: span, turn: nil, id: span.id, collapsed?: false, has_children?: has_children?}
      turn_rows = Enum.map(turns, &%{depth: depth + 1, span: span, turn: &1, id: span.id <> "#t#{&1.number}", collapsed?: false, has_children?: false})
      child_rows = Enum.flat_map(Store.children(forest, span.id), &rows_for(forest, &1, depth + 1, ui))
      [run_row | turn_rows] ++ child_rows
    else
      [%{depth: depth, span: span, turn: nil, id: span.id, collapsed?: true, has_children?: has_children?}]
    end
  end

  # Non-run span (llm / tool): the row, then (IF expanded) its children
  # (tool -> nested run). A leaf llm has no children and is never "collapsed".
  defp rows_for(forest, %Span{} = span, depth, ui) do
    children = Store.children(forest, span.id)
    has_children? = children != []

    if has_children? and not Ui.expanded?(ui, depth, span.id) do
      [%{depth: depth, span: span, turn: nil, id: span.id, collapsed?: true, has_children?: true}]
    else
      [%{depth: depth, span: span, turn: nil, id: span.id, collapsed?: false, has_children?: has_children?}
       | Enum.flat_map(children, &rows_for(forest, &1, depth + 1, ui))]
    end
  end

  defp rows_for(_forest, nil, _depth, _ui), do: []

  defp clamp_cursor(_cursor, []), do: 0
  defp clamp_cursor(cursor, rows), do: cursor |> max(0) |> min(length(rows) - 1)

  # ---- row formatting (pure strings; no widget structs) ----

  @doc false
  def render_row(%{depth: depth, turn: turn} = row, selected?) do
    indent = String.duplicate("  ", depth)
    # Cursor marker (›) is distinct from the disclosure glyph (▸ collapsed / ▾
    # expanded), so a selected collapsed node reads "› ▸ …" unambiguously.
    marker = if selected?, do: "› ", else: "  "
    %{text: marker <> indent <> disclosure(row) <> label(row), status: status_of(row), turn?: not is_nil(turn)}
  end

  # Disclosure glyph: ▸ when a node has hidden children (collapsed), ▾ when it has
  # children and they're shown (expanded), blank for leaves. Tolerant of rows that
  # predate the flags (legacy callers) — then no glyph.
  defp disclosure(%{has_children?: true, collapsed?: true}), do: "▸ "
  defp disclosure(%{has_children?: true, collapsed?: false}), do: "▾ "
  defp disclosure(_), do: ""

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
