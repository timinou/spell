defmodule SpellAgent.Hist.Spans do
  @moduledoc """
  Pure readers over a persisted span subtree (PLAN-001, C5 SPANS).

  While `SpellAgent.Tui.Store` builds a live forest from telemetry, each turn's
  recorded `Node.span_root` preserves a snapshot of that interior for later
  inspection. `Hist.Spans` provides read-only access to those snapshots: flatten
  the tree, sum token tallies, and trace tool invocations across the whole
  session.

  Span maps are kept as plain maps with string-or-atom keys; all accessors are
  defensive against `nil`, missing children, and mixed key types.

  ## Use-case

  The agent asks: "how much did that turn cost?", "which tool calls were nested
  inside the sub-agent?", "show me every `find` tool span and its duration".
  `Hist.Spans` answers from the durable log, not from live telemetry.
  """

  alias SpellAgent.Hist.Node
  alias SpellAgent.Hist.Store

  @doc """
  Flatten a span subtree into a list (DFS pre-order).

  Accepts either a `Node.t()` or a span-root map. Returns `[]` when the root is
  `nil` or not a map.
  """
  @spec spans(Node.t() | map() | nil) :: [map()]
  def spans(nil), do: []

  def spans(%Node{span_root: root}), do: spans(root)

  def spans(root) when not is_map(root), do: []

  def spans(root) do
    [root | children(root) |> Enum.flat_map(&spans/1)]
  end

  @doc """
  Sum token tallies found anywhere in the span subtree.

  Handles two telemetry shapes:

    * `%{input: i, output: o}` — counted as-is
    * `%{tokens: n}` — counted as input tokens (total still reflects `n`)

  Returns `%{input: integer(), output: integer()}`.
  """
  @spec cost(Node.t() | map() | nil) :: %{input: integer(), output: integer()}
  def cost(node_or_root) do
    node_or_root
    |> spans()
    |> Enum.reduce(%{input: 0, output: 0}, fn span, acc ->
      # Token maps may be atom- OR string-keyed (live telemetry vs persisted),
      # so read inner fields through the mixed-key accessor (BUG-001 B6).
      case get(span, :tokens) do
        tokens when is_map(tokens) ->
          i = get(tokens, :input)
          o = get(tokens, :output)
          n = get(tokens, :tokens)

          cond do
            is_integer(i) and is_integer(o) -> %{input: acc.input + i, output: acc.output + o}
            is_integer(n) -> %{input: acc.input + n, output: acc.output}
            true -> acc
          end

        _ ->
          acc
      end
    end)
  end

  @doc """
  Across all session nodes, return every tool span whose name matches
  `tool_name`.

  Each hit is a span map enriched with `:node_id` and `:node_seq`. Duration and
  result are included when present on the span.
  """
  @spec trace(module(), String.t(), String.t()) :: [map()]
  def trace(impl, session_id, tool_name) do
    Store.list(impl, :node, session_id)
    |> Enum.sort_by(& &1.seq)
    |> Enum.flat_map(fn %Node{id: nid, seq: seq, span_root: root} ->
      root
      |> spans()
      |> Enum.filter(&tool_match?(&1, tool_name))
      |> Enum.map(fn span ->
        span
        |> Map.put(:node_id, nid)
        |> Map.put(:node_seq, seq)
      end)
    end)
  end

  # --- defensive accessors ---

  defp children(span) when is_map(span) do
    get(span, :children) || []
  end


  defp tool_match?(span, tool_name) do
    kind = get(span, :kind)
    name = get(span, :name) || tool_name_from_meta(span)
    kind in [:tool, "tool"] and name == tool_name
  end

  defp tool_name_from_meta(span) when is_map(span) do
    meta = get(span, :meta) || %{}
    get(meta, :tool_name) || get(meta, "tool_name")
  end

  defp tool_name_from_meta(_), do: nil

  # Get a key that may be stored as atom or string.
  defp get(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} -> value
      :error -> Map.get(map, to_string(key))
    end
  end

  defp get(_map, _key), do: nil
end
