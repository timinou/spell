defmodule SpellAgent.Hist.Reconstitute do
  @moduledoc """
  Deterministically rebuild the live environment from the log (PLAN-001, C1).

  This is the resume primitive the user asked for explicitly: NOT a re-execution
  (that is the FUP-REEVAL vision), but a pure FOLD over recorded data. Walking
  root→cursor and merging each node's realized `binds` reconstructs the exact def
  environment the agent had — its computed values and (via `tools`) its
  self-authored tools — with ZERO tool calls and ZERO LLM calls. Same inputs →
  same env, every time.

  ## What it returns

  A `SpellAgent.Hist.View` struct — `session_id`, `cursor`, `tip`, `env`, `tools`,
  `messages`, `nodes`. See that module for field semantics. A `View` is still a
  map, so `%{env: env} = view` destructuring keeps working.

  ## Snapshot acceleration

  If a `Snapshot` exists at or above the cursor on the path, the fold starts from
  its full env and replays only the tail — O(distance-to-snapshot) instead of
  O(depth). Without one it folds from the root. Either way the result is identical;
  the snapshot is a cache, never a source of truth.
  """

  alias SpellAgent.Hist.{Node, Session, Snapshot, ToolDef, View}
  alias SpellAgent.Hist.Store

  @doc """
  Rebuild state at a session's cursor (default `:main`). Returns `{:ok, View.t()}`,
  or `{:error, :no_session}` / `{:error, :no_cursor}`.
  """
  @spec at(module(), String.t(), atom()) ::
          {:ok, View.t()} | {:error, :no_session | :no_cursor}
  def at(impl, session_id, cursor \\ :main) do
    with {:ok, %Session{cursors: cursors}} <- fetch_session(impl, session_id),
         node_id when is_binary(node_id) <- Map.get(cursors, cursor) || {:error, :no_cursor},
         {:ok, %Node{} = tip} <- Store.fetch(impl, {:node, session_id, node_id}) do
      slice = slice_to(impl, tip)
      {env, tools_at} = fold_env(impl, session_id, slice)

      {:ok,
       %View{
         session_id: session_id,
         cursor: cursor,
         tip: tip,
         env: env,
         tools: resolve_tools(impl, tools_at),
         messages: to_messages(slice),
         nodes: slice
       }}
    else
      {:error, _} = e -> e
      nil -> {:error, :no_cursor}
    end
  end

  @doc "The root→node slice (root first) — the conversation path to a node."
  @spec slice_to(module(), Node.t()) :: [Node.t()]
  def slice_to(impl, %Node{} = node), do: ancestors(impl, node, [node])

  @doc """
  Project a slice to an interleaved chat transcript (the chat lens).

  Each node contributes up to two messages IN PATH ORDER: the user `prompt` that
  opened its step (head nodes only — interior turns carry `nil`), then the
  assistant `say` it produced. This yields a faithful `user -> assistant -> user
  -> assistant` transcript across many recorded runs, which is exactly what a TUI
  scrollback or an LLM resume context needs. A node missing either half simply
  omits that message; ordering is preserved.
  """
  @spec to_messages([Node.t()]) :: [View.message()]
  def to_messages(slice) do
    Enum.flat_map(slice, fn %Node{prompt: prompt, say: say} ->
      user =
        if is_binary(prompt) and prompt != "", do: [%{role: :user, content: prompt}], else: []

      asst = if is_binary(say), do: [%{role: :assistant, content: say}], else: []
      user ++ asst
    end)
  end

  # --- internals ---

  defp fetch_session(impl, session_id) do
    case Store.fetch(impl, {:session, session_id}) do
      {:ok, %Session{} = s} -> {:ok, s}
      :error -> {:error, :no_session}
    end
  end

  defp ancestors(_impl, %Node{parent_id: nil}, acc), do: acc

  defp ancestors(impl, %Node{parent_id: pid, session: sid}, acc) do
    case Store.fetch(impl, {:node, sid, pid}) do
      {:ok, parent} -> ancestors(impl, parent, [parent | acc])
      :error -> acc
    end
  end

  # Fold binds along the slice, starting from the nearest snapshot if present.
  # Returns {env, tool_names_live}.
  defp fold_env(impl, session_id, slice) do
    {base_env, base_tools, tail} = snapshot_base(impl, session_id, slice)

    Enum.reduce(tail, {base_env, base_tools}, fn %Node{binds: binds, tools_defined: td},
                                                 {env, tools} ->
      {Node.apply_binds(env, binds), tools ++ td}
    end)
    |> then(fn {env, tools} -> {env, Enum.uniq(tools)} end)
  end

  # Find the deepest node in the slice that has a snapshot; fold only nodes after it.
  defp snapshot_base(impl, session_id, slice) do
    indexed = Enum.with_index(slice)

    snap_hit =
      indexed
      |> Enum.reverse()
      |> Enum.find_value(fn {%Node{id: nid}, idx} ->
        case Store.fetch(impl, {:snap, session_id, nid}) do
          {:ok, %Snapshot{} = s} -> {s, idx}
          :error -> nil
        end
      end)

    case snap_hit do
      {%Snapshot{env: env, tools: tools}, idx} -> {env, tools, Enum.drop(slice, idx + 1)}
      nil -> {%{}, [], slice}
    end
  end

  # Map live tool NAMES to ToolDef records when present in the durable tool store;
  # names without a record are kept as bare-name stubs so the caller can still
  # re-register from the source captured elsewhere.
  defp resolve_tools(impl, names) do
    Enum.map(names, fn name ->
      case Store.fetch(impl, {:tool, name}) do
        {:ok, %ToolDef{} = td} -> td
        :error -> %ToolDef{name: name, source: nil, scope: :session}
      end
    end)
  end
end
