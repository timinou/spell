defmodule SpellAgent.Hist.Window do
  @moduledoc """
  Lossless context compaction over a persisted conversation (PLAN-001, C6).

  PtcRunner's `SubAgent.Compaction` ships Phase-1 `:trim`, which DELETES old turns
  from the LLM message list to fit the context window, and documents Phase-2
  `:summarize` as unimplemented — because trimming-by-deletion has nowhere to keep
  the originals. With a durable history, trimming becomes WINDOWING: the full log
  is retained, and only the VISIBLE slice narrows. Three operations:

    * `window/3` — the compacted slice the LLM should see: keep the initial user
      turn + the N most-recent turns, dropping the middle from VIEW (never from the
      store). This is what feeds `SubAgent.Compaction` instead of a destructive trim.
    * `recall/3` — pull a previously-trimmed (out-of-window) node back when it
      becomes relevant, by keyword match over its `say`/`form_src`. Reversible
      compaction: the middle isn't gone, it's one query away.
    * `distill/4` — Phase-2 summarize: replace a span of turns in the VIEW with a
      single distilled node (a `:clearing` mark + a synthetic summary node), while
      the originals stay in the store as the distillation's evidence.

  Everything here is a VIEW computation over the stored slice; it never mutates or
  deletes a recorded node. "Forgetting" is narrowing what is shown, plus an
  explicit distillation that keeps provenance — never data loss.
  """

  alias SpellAgent.Hist.{Id, Mark, Node, Reconstitute}
  alias SpellAgent.Hist.Store

  @doc """
  The windowed slice at a session's cursor: the first node (opening turn) plus the
  `keep_recent` most-recent nodes, in path order. Middle nodes are omitted from the
  RETURNED view but remain in the store.

  Opts:
    * `:keep_recent` — number of recent nodes to keep verbatim (default 3)
    * `:keep_initial` — keep the first node of the slice (default true)
    * `:cursor` — which cursor (default `:main`)

  Returns `{:ok, %{shown: [Node.t()], trimmed: [Node.t()]}}` or a Reconstitute error.
  """
  @spec window(module(), String.t(), keyword()) ::
          {:ok, %{shown: [Node.t()], trimmed: [Node.t()]}} | {:error, term()}
  def window(impl, session_id, opts \\ []) do
    keep_recent = Keyword.get(opts, :keep_recent, 3)
    keep_initial = Keyword.get(opts, :keep_initial, true)
    cursor = Keyword.get(opts, :cursor, :main)

    with {:ok, %{nodes: slice}} <- Reconstitute.at(impl, session_id, cursor) do
      {:ok, partition(slice, keep_recent, keep_initial)}
    end
  end

  @doc """
  Search the OUT-OF-WINDOW (trimmed) nodes for ones matching `query` — a substring
  matched case-insensitively against each node's `say` and `form_src`. This is how
  a trimmed turn is pulled back into context on demand (reversible compaction).

  Returns the matching `[Node.t()]` in path order.
  """
  @spec recall(module(), String.t(), String.t(), keyword()) :: [Node.t()]
  def recall(impl, session_id, query, opts \\ []) do
    case window(impl, session_id, opts) do
      {:ok, %{trimmed: trimmed}} ->
        q = String.downcase(query)
        Enum.filter(trimmed, &node_matches?(&1, q))

      {:error, _} ->
        []
    end
  end

  @doc """
  Phase-2 distill: summarize the nodes `node_ids` into one synthetic summary node
  appended under `parent_id`, and drop a `:clearing` mark recording the
  distillation. The ORIGINAL nodes are untouched in the store — the summary node's
  `tools_defined` carries no tools, its `say` is `summary`, and the mark's note
  links back to the distilled ids (provenance).

  Returns `{:ok, %{summary: Node.t(), mark: Mark.t()}}`.
  """
  @spec distill(module(), String.t(), [String.t()], keyword()) ::
          {:ok, %{summary: Node.t(), mark: Mark.t()}} | {:error, :empty_distill}
  def distill(impl, session_id, node_ids, opts \\ [])

  def distill(_impl, _session_id, [], _opts), do: {:error, :empty_distill}

  def distill(impl, session_id, node_ids, opts) do
    summary = Keyword.get(opts, :summary, "distilled #{length(node_ids)} turns")
    parent_id = Keyword.get(opts, :parent, List.last(node_ids))

    # All distilled ids + the explicit parent must exist, else the summary would
    # dangle off ghost history (BUG-003 B2).
    if missing_nodes(impl, session_id, [parent_id | node_ids]) != [] do
      {:error, :unknown_nodes}
    else
      do_distill(impl, session_id, node_ids, parent_id, summary)
    end
  end

  defp do_distill(impl, session_id, node_ids, parent_id, summary) do
    sid = session_id
    seq = next_seq(impl, sid)

    # Identity includes the summary + seq so re-distilling the same ids with a
    # different summary APPENDS a new node instead of overwriting (BUG-003 B1).
    src = "(comment :distilled #{inspect(node_ids)} :summary #{inspect(summary)} :seq #{seq})"

    node = %Node{
      id: Id.node_id(src, parent_id),
      session: sid,
      parent_id: parent_id,
      seq: seq,
      kind: :turn,
      status: :ok,
      form: nil,
      form_src: src,
      binds: %{},
      result: nil,
      sees: [],
      prints: [],
      say: summary,
      tools_defined: [],
      t: System.system_time(:millisecond)
    }

    Store.put(impl, {:node, sid, node.id}, node)

    mark = %Mark{
      id: Id.rand("mark"),
      session: sid,
      node_id: node.id,
      kind: :clearing,
      note: "distilled #{Enum.join(node_ids, ",")}: #{summary}",
      t: System.system_time(:millisecond)
    }

    Store.put(impl, {:mark, sid, mark.id}, mark)

    {:ok, %{summary: node, mark: mark}}
  end

  # --- internals ---

  defp partition(slice, keep_recent, keep_initial) do
    n = length(slice)
    recent_from = max(n - keep_recent, 0)

    {shown, trimmed} =
      slice
      |> Enum.with_index()
      |> Enum.split_with(fn {_node, idx} ->
        idx >= recent_from or (keep_initial and idx == 0)
      end)

    %{
      shown: shown |> Enum.map(&elem(&1, 0)),
      trimmed: trimmed |> Enum.map(&elem(&1, 0))
    }
  end

  defp node_matches?(%Node{say: say, form_src: src}, q) do
    haystack = String.downcase("#{say} #{src}")
    String.contains?(haystack, q)
  end

  # Ids from the given list that do NOT resolve to a stored node in the session.
  # nil (a legitimate root parent) is ignored.
  defp missing_nodes(impl, session_id, ids) do
    ids
    |> Enum.reject(&is_nil/1)
    |> Enum.reject(fn id -> match?({:ok, _}, Store.fetch(impl, {:node, session_id, id})) end)
  end

  defp next_seq(impl, session_id) do
    impl
    |> Store.list(:node, session_id)
    |> Enum.map(& &1.seq)
    |> Enum.max(fn -> 0 end)
    |> Kernel.+(1)
  end
end
