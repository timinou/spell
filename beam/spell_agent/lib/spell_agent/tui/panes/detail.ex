defmodule SpellAgent.Tui.Panes.Detail do
  @moduledoc """
  The detail / inspector pane (PLAN-346 W5) — "see inside the turn".

  The span tree shows truncated one-liners; this pane renders the FULL content of
  whatever the tree cursor is on, so navigating the tree IS inspecting it (the
  screenshot problem: a turn row that's clipped to 40 chars now expands here).

  It MIRRORS the tree's selection: `project/2` reads the live forest + gaze, asks
  `SpanTree.selected_row/2` for the row under the cursor, and folds it into a
  detail view-model (a title + a body string). A turn row shows its program +
  result + reasoning; a run/llm/tool row shows its label, status, tokens, timing,
  and summarized args/result. Pure (forest+gaze -> vm) ⇒ unit-testable.

  As a CONTEXT it owns `context_name/0 = :detail`; navigation chords resolve
  through TurnNav when this pane is focused (scroll), so it needs no keymap of its
  own beyond what Global + TurnNav already provide.
  """

  use SpellAgent.Tui.Pane

  alias SpellAgent.Tui.Store
  alias SpellAgent.Tui.Store.Span
  alias SpellAgent.Tui.Ui
  alias SpellAgent.Tui.Panes.SpanTree

  @spec context_name() :: :detail
  def context_name, do: :detail

  # Wake whenever the forest changes (new spans/turns) OR the cursor moves; the
  # App reprojects with :all on navigation, so an empty events list (always-dirty)
  # keeps the detail in lock-step with the selection cheaply.
  @impl true
  def events, do: []

  @type vm :: %{title: String.t(), body: String.t()}

  @impl true
  def project(forest, assigns) do
    ui = assigns_ui(assigns)

    case SpanTree.selected_row(forest, ui) do
      nil -> %{title: "detail", body: "(no selection \u2014 run a mission, then j/k to explore)"}
      row -> detail_of(forest, row)
    end
  end

  @impl true
  def view(%{vm: %{title: title, body: body}, rect: rect, assigns: assigns, focused?: focused?}) do
    scroll = (assigns[:ui] && Ui.scroll_of(assigns.ui, :detail)) || 0
    # Return a descriptor the App materializes into a scrollable Paragraph (keeps
    # this pane NIF-free + unit-testable, same contract as SpanTree's :list).
    [{{:detail, %{title: title, body: body, scroll: scroll, focused?: focused?}}, rect}]
  end

  # ---- pure folding: a row -> {title, body} ----

  @doc false
  def detail_of(_forest, %{turn: %{} = turn}) do
    %{
      title: "turn #{turn[:number]} #{glyph(turn[:status])}",
      body:
        section("program", turn[:program]) <>
          section("result", turn[:result_preview]) <>
          section("reasoning", turn[:response])
    }
  end

  def detail_of(forest, %{span: %Span{} = span}) do
    %{
      title: "#{span.kind} #{glyph(span.status)} #{span.label}",
      body:
        kv("id", span.id) <>
          kv("status", span.status) <>
          kv("duration", dur(span)) <>
          kv("tokens", tokens(span.tokens)) <>
          kv("children", length(Store.children(forest, span.id))) <>
          meta_section(span.meta)
    }
  end

  def detail_of(_forest, _row), do: %{title: "detail", body: "(nothing to show)"}

  # ---- helpers ----

  defp assigns_ui(%{ui: %Ui{} = ui}), do: ui
  defp assigns_ui(_), do: %Ui{auto_depth: 1_000_000, overrides: %{}}

  defp section(_label, nil), do: ""
  defp section(_label, ""), do: ""
  defp section(label, text) when is_binary(text), do: "\u2500\u2500 #{label} \u2500\u2500\n#{text}\n\n"
  defp section(label, other), do: section(label, inspect(other, pretty: true))

  defp kv(_k, nil), do: ""
  defp kv(_k, ""), do: ""
  defp kv(k, v), do: "#{k}: #{value(v)}\n"

  defp value(v) when is_binary(v), do: v
  defp value(v) when is_atom(v), do: to_string(v)
  defp value(v), do: inspect(v)

  # The interesting bits of a span's stored telemetry metadata (program, result,
  # args, response, ...), each as its own section; skip noisy/empty keys.
  defp meta_section(meta) when is_map(meta) and map_size(meta) > 0 do
    [:program, :result, :args, :response, :raw_response]
    |> Enum.map(fn k -> section(to_string(k), Map.get(meta, k)) end)
    |> Enum.join()
    |> case do
      "" -> ""
      sections -> "\n" <> sections
    end
  end

  defp meta_section(_), do: ""

  defp dur(%Span{} = s) do
    case Span.duration_ms(s) do
      nil -> nil
      ms -> "#{ms}ms"
    end
  end

  defp tokens(%{input: i, output: o}) when is_integer(i) and is_integer(o), do: "#{i}\u2192#{o}"
  defp tokens(%{tokens: t}) when is_integer(t), do: "#{t}"
  defp tokens(_), do: nil

  defp glyph(:ok), do: "\u2713"
  defp glyph(:error), do: "\u2717"
  defp glyph(_), do: "\u2026"
end
