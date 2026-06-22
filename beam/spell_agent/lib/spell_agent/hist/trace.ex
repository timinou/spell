defmodule SpellAgent.Hist.Trace do
  @moduledoc """
  A session's conversation TRACE as flat, renderable rows (PLAN-010, C4).

  This is the read-side of "read their traces": given a session id, fold its
  recorded `Hist.Node` chain into a list of node rows — one per turn, in `seq`
  order — each carrying the homoiconic essentials (`form_src`, `say`, `result`,
  `tokens`, status) plus whether it has an execution INTERIOR to drill into.

  A node's interior is its `span_root`: the frozen `run -> llm -> tool -> nested
  run` subtree captured at record time. `interior/1` flattens that subtree into
  depth-tagged rows (reusing the same defensive, mixed-key accessors as
  `Hist.Spans`) so a reader can expand a turn and see what ran inside it.

  ## Two levels, both pure

      rows(impl, session_id)  -> [node_row]      the turns of the conversation
      interior(node_or_root)  -> [span_row]      the execution tree of one turn

  Both are pure `(data -> rows)` with no LLM and no tool calls, so they unit-test
  against `Store.Memory` exactly like `Hist.Query`/`Hist.Spans`.
  """

  alias SpellAgent.Hist.{Node, Spans, Store}

  @typedoc "One turn of the conversation, flattened for display."
  @type node_row :: %{
          node_id: String.t(),
          seq: non_neg_integer(),
          kind: Node.kind(),
          status: Node.status(),
          prompt: String.t() | nil,
          form_src: String.t() | nil,
          say: String.t() | nil,
          result: term(),
          tokens: %{input: integer(), output: integer()} | nil,
          tools_defined: [String.t()],
          has_interior?: boolean()
        }

  @typedoc "One node in a turn's execution interior (its span_root subtree)."
  @type span_row :: %{
          depth: non_neg_integer(),
          kind: term(),
          name: String.t() | nil,
          status: term(),
          tokens: term()
        }

  @doc """
  The session's turns as node rows, ordered by `seq` (oldest first).

  Reads every recorded node for `session_id` directly from the store — the whole
  conversation, not just the `:main` cursor path — so branches and resumed tails
  are all visible in a trace dump. An unrecorded session yields `[]`.
  """
  @spec rows(module(), String.t()) :: [node_row()]
  def rows(impl, session_id) when is_binary(session_id) do
    impl
    |> Store.list(:node, session_id)
    |> Enum.sort_by(& &1.seq)
    |> Enum.map(&node_row/1)
  end

  @doc """
  The execution interior of one turn as depth-tagged span rows (DFS pre-order).

  Accepts a `Node.t()` or a raw `span_root` map. The root span is depth 0, its
  children depth 1, and so on. Returns `[]` when there is no interior (a turn that
  recorded no `span_root`).
  """
  @spec interior(Node.t() | map() | nil) :: [span_row()]
  def interior(%Node{span_root: root}), do: interior(root)
  def interior(nil), do: []
  def interior(root) when not is_map(root), do: []
  def interior(root), do: root |> walk(0, []) |> Enum.reverse()

  @doc """
  Token cost of one turn's interior — delegates to `Hist.Spans.cost/1` so the
  trace reader and the `hist/spans` verb agree on the number.
  """
  @spec interior_cost(Node.t() | map() | nil) :: %{input: integer(), output: integer()}
  def interior_cost(node_or_root), do: Spans.cost(node_or_root)

  @doc """
  The execution interior of a node looked up by id — fetch then flatten.

  Convenience for a reader that has a `session_id` + `node_id` (e.g. the browser
  expanding a turn) rather than the `Node` in hand. Returns `[]` for an unknown
  node or one with no `span_root`.
  """
  @spec interior_of(module(), String.t(), String.t()) :: [span_row()]
  def interior_of(impl, session_id, node_id) do
    case Store.fetch(impl, {:node, session_id, node_id}) do
      {:ok, %Node{} = node} -> interior(node)
      _ -> []
    end
  end

  # ---- node row ----

  defp node_row(%Node{} = n) do
    %{
      node_id: n.id,
      seq: n.seq,
      kind: n.kind,
      status: n.status,
      prompt: n.prompt,
      form_src: n.form_src,
      say: n.say,
      result: n.result,
      tokens: n.tokens,
      tools_defined: n.tools_defined || [],
      has_interior?: has_interior?(n.span_root)
    }
  end

  defp has_interior?(root) when is_map(root), do: true
  defp has_interior?(_), do: false

  # ---- interior walk (depth-tagged DFS, mixed-key tolerant) ----

  # Append this span as a row, then recurse into children at depth+1. Built with
  # an accumulator so order is a stable pre-order (parent before its children).
  defp walk(span, depth, acc) when is_map(span) do
    acc = [span_row(span, depth) | acc]
    Enum.reduce(children(span), acc, fn child, a -> walk(child, depth + 1, a) end)
  end

  defp walk(_other, _depth, acc), do: acc

  # `rows/1`-style consumers want oldest-first/parent-first; we built the acc in
  # reverse, so the public functions reverse once at the boundary.
  defp span_row(span, depth) do
    %{
      depth: depth,
      kind: get(span, :kind),
      name: span_name(span),
      status: get(span, :status),
      tokens: get(span, :tokens)
    }
  end

  defp children(span) when is_map(span) do
    case get(span, :children) do
      list when is_list(list) -> list
      _ -> []
    end
  end

  defp span_name(span) do
    get(span, :name) || get(span, :label) || tool_name(span)
  end

  defp tool_name(span) do
    meta = get(span, :meta) || %{}
    get(meta, :tool_name) || get(meta, "tool_name")
  end

  # Atom- OR string-keyed read (persisted span maps mix both — same accessor shape
  # as Hist.Spans).
  defp get(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} -> value
      :error -> Map.get(map, to_string(key))
    end
  end

  defp get(_map, _key), do: nil
end
