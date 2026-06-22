defmodule SpellAgent.Tui.SessionView do
  @moduledoc """
  Pure formatting for the session browser (PLAN-010, C6) — rows -> display lines.

  The ONE place that turns `Hist.SessionList` rows and `Hist.Trace` rows into the
  strings a human reads, shared by every surface: the interactive
  `SessionBrowser` TUI, the plain-text `mix spell.sessions --list/--trace` modes,
  and the headless snapshot test. Keeping it pure (data -> strings, no widgets,
  no IO) means the byte-for-byte output is testable without a terminal, and the
  TUI and the stdout dump can never drift.

  Two families:

    * `list_lines/1` — the session index: one line per session, `live?` marked.
    * `trace_lines/2` — a session's trace: a node line per turn, optionally
      followed by its interior span lines when the turn is expanded.
  """



  @typedoc "A formatted line tagged for styling (status drives color in the TUI)."
  @type line :: %{text: String.t(), status: :ok | :error | :neutral, kind: atom()}

  # ---- session list ----

  @doc """
  Format the session list into one line per session.

  Each line: a `●`/`○` live marker, the short id, turn count + token total, the
  model, and the opening prompt (truncated). An empty list yields a single
  empty-state line so the pane never renders blank.
  """
  @spec list_lines([map()]) :: [line()]
  def list_lines([]), do: [neutral("(no sessions yet — run a mission, then reopen)", :empty)]

  def list_lines(rows) when is_list(rows) do
    Enum.map(rows, &list_line/1)
  end

  defp list_line(row) do
    marker = if row.live?, do: "● ", else: "○ "
    live = if row.live?, do: "live ", else: ""
    cost = row.cost[:total] || 0

    text =
      marker <>
        short_id(row.session_id) <>
        "  " <> live <> "#{row.turns}t #{cost}tok" <>
        model_part(row.model) <>
        prompt_part(row.prompt)

    %{text: text, status: if(row.live?, do: :ok, else: :neutral), kind: :session}
  end

  # ---- trace ----

  @doc """
  Format a session's trace into lines. `interiors` is a map `node_id => [span_row]`
  for the turns whose execution interior should be shown inline (depth-indented)
  under the turn; a node absent from the map is rendered collapsed.

  Each turn becomes a node line (`seq`, status glyph, a one-line summary from
  `form_src`/`say`/`result`); an expanded turn appends its span rows. An empty
  trace yields an empty-state line.
  """
  @spec trace_lines([map()], %{optional(String.t()) => [map()]}) :: [line()]
  def trace_lines(rows, interiors \\ %{})

  def trace_lines([], _interiors),
    do: [neutral("(no trace — this session recorded no turns)", :empty)]

  def trace_lines(rows, interiors) when is_list(rows) do
    Enum.flat_map(rows, fn row -> node_lines(row, Map.get(interiors, row.node_id)) end)
  end

  defp node_lines(row, interior) do
    expanded? = is_list(interior)
    disclosure =
      cond do
        not row.has_interior? -> "  "
        expanded? -> "▾ "
        true -> "▸ "
      end

    head = %{
      text: disclosure <> "##{row.seq} #{glyph(row.status)} #{summary(row)}",
      status: status_of(row.status),
      kind: :node
    }

    if expanded? and row.has_interior? do
      [head | interior_lines(interior)]
    else
      [head]
    end
  end

  defp interior_lines(spans) do
    spans
    |> Enum.map(fn span ->
      indent = String.duplicate("  ", (span.depth || 0) + 2)
      name = span.name || ""

      %{
        text: indent <> "#{span_glyph(span.status)} #{span.kind} #{name}" |> String.trim_trailing(),
        status: status_of(span.status),
        kind: :span
      }
    end)
  end

  # ---- summaries ----

  defp summary(row) do
    cond do
      present?(row.prompt) -> "» " <> oneline(row.prompt, 60)
      present?(row.form_src) -> oneline(row.form_src, 70)
      present?(row.say) -> oneline(row.say, 70)
      true -> result_summary(row.result)
    end
  end

  defp result_summary(nil), do: "(no output)"
  defp result_summary(r) when is_binary(r), do: oneline(r, 70)
  defp result_summary(r), do: oneline(inspect(r), 70)

  # ---- plain text rendering (stdout modes) ----

  @doc "Render formatted lines to a single newline-joined string (stdout dumps)."
  @spec to_text([line()]) :: String.t()
  def to_text(lines), do: Enum.map_join(lines, "\n", & &1.text)

  # ---- helpers ----

  defp model_part(nil), do: ""
  defp model_part(m) when is_binary(m), do: "  " <> short_model(m)
  defp model_part(_), do: ""

  defp prompt_part(p) do
    if present?(p), do: "  » " <> oneline(p, 48), else: ""
  end

  # A model id's distinctive tail (drop the vendor date suffix for brevity).
  defp short_model(m) do
    m |> String.replace(~r/-\d{8}$/, "") |> String.replace_prefix("claude-", "")
  end

  # First 8 chars after a `sess_`-style prefix, else the head — enough to pick a
  # session apart without the full collision-resistant id.
  defp short_id(id) when is_binary(id) do
    case String.split(id, "_", parts: 2) do
      [_prefix, rest] -> String.slice(rest, 0, 12)
      [whole] -> String.slice(whole, 0, 12)
    end
  end

  defp short_id(_), do: "?"

  defp oneline(s, n) when is_binary(s) do
    flat = s |> String.replace(~r/\s+/, " ") |> String.trim()
    if String.length(flat) > n, do: String.slice(flat, 0, n - 1) <> "…", else: flat
  end

  defp oneline(other, n), do: oneline(inspect(other), n)

  defp present?(s), do: is_binary(s) and s != ""

  defp neutral(text, kind), do: %{text: text, status: :neutral, kind: kind}

  defp glyph(:ok), do: "✓"
  defp glyph(:error), do: "✗"
  defp glyph(_), do: "…"

  defp span_glyph(s) when s in [:ok, "ok"], do: "✓"
  defp span_glyph(s) when s in [:error, "error"], do: "✗"
  defp span_glyph(_), do: "·"

  defp status_of(s) when s in [:error, "error"], do: :error
  defp status_of(s) when s in [:ok, "ok"], do: :ok
  defp status_of(_), do: :neutral
end
