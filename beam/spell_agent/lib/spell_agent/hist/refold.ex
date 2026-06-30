defmodule SpellAgent.Hist.Refold do
  @moduledoc """
  Rebuild a replayable native message tape from the L1 node DAG (PLAN-018 W3).

  This is the fidelity-preserving inverse of `SpellAgent.Hist.Recorder`: where the
  recorder distills a live `step.messages` tape DOWN into nodes, `refold` rebuilds
  a provider-valid tape back UP from those nodes. It is the realization of the
  long-deferred PLAN-006 FUP-EDIT-REFOLD upgrade named in `Hist.Cont`: "an
  edited/branched suffix reconstructing the tape from L1."

  ## Why this is NOT `Reconstitute.to_messages`

  `Reconstitute.to_messages/1` is the LOSSY CHAT lens — it keeps only the user
  `prompt` and the assistant `say` prose, dropping every program and tool call.
  That is correct for a scrollback pane but WRONG as an LLM feed: the model would
  forget every action it took. `refold` is the high-fidelity sibling: it
  reconstructs the `tool_use` / `tool_result` blocks the provider requires, so the
  model re-enters seeing its own programs and their results.

  ## The reconstruction (inverse of `assistant_with_tool_calls_messages`)

  The agent runs `ptc_transport: :tool_call`: each turn the model emits exactly one
  native `lisp_eval` tool call whose argument is the PTC-Lisp `program`, and the
  tool result is that program's return. A recorded `Node` stores the pieces of
  that exchange — `prompt`, `say`, `form_src` (the program), `result` — but NOT the
  ephemeral native call id or the rendered result JSON. `refold` synthesizes them:

    * user turn      -> `%{role: :user, content: prompt}` (head nodes only)
    * assistant turn -> `%{role: :assistant, content: say||"",
                            tool_calls: [<lisp_eval call, id synthesized>]}`
    * tool result    -> `%{role: :tool, tool_call_id: <same id>, content: <result>}`

  The call id is DERIVED DETERMINISTICALLY from the node id (`call_<node_id>`), so
  the same DAG refolds to a byte-identical tape every time (the determinism
  invariant a downstream content-address depends on) and the `tool_use` <->
  `tool_result` pairing the provider enforces is guaranteed by construction (one
  id, emitted on both blocks, in order).

  A node that recorded no program (`form_src == nil`, e.g. a synthetic or
  pure-prose turn) contributes only its user/assistant prose, with no tool blocks
  — never a half-pair.

  ## Fidelity boundary (what L1 can and cannot reproduce)

  refold rebuilds a SEMANTICALLY FAITHFUL, provider-valid tape — NOT a
  byte-identical copy of the original wire. The L1 node is a DISTILLATION: it
  retains the program (`form_src`), the result, and the status, but DROPS the
  live `PtcToolProtocol` result envelope (prints, feedback, memory deltas,
  truncation fields) and the model's raw assistant prose emitted alongside a tool
  call. So:

    * the tool_result content is a MINIMAL reconstructed envelope `{"status",
      "result"}` — the load-bearing signal (did the turn succeed, what did it
      return), not the full live payload (which L1 never stored);
    * a program turn's assistant content is `""` (the common live case: the model
      emitted only the tool call), since the original prose is not retained.

  This is the correct contract for a RESUME/REDUCE feed: the model re-enters
  seeing its programs, their outcomes, and its conversation — enough to continue
  coherently — without the harness pretending to reproduce bytes it discarded.

  ## Output shape

  Native SubAgent messages (`Hist.Cont.message/0` shape): `%{role:, content:}`
  with optional `tool_calls` / `tool_call_id`, exactly what `Anthropic.convert_*`
  consumes. The system prompt is NOT included (the loop regenerates it every turn,
  same as `Recorder.strip_system/1`).
  """

  alias SpellAgent.Hist.{Node, Reconstitute}
  alias SpellAgent.Hist.Store

  @lisp_eval_name "lisp_eval"

  @doc """
  Refold a session's root->cursor slice into a replayable native tape.

  Returns `{:ok, [message]}`, or `{:error, :no_session | :no_cursor}` mirroring
  `Reconstitute.at/3`. The tape is ordered root-first, ready to feed as
  `initial_messages` on the next turn.
  """
  @spec to_tape(module(), String.t(), atom()) ::
          {:ok, [map()]} | {:error, :no_session | :no_cursor}
  def to_tape(impl, session_id, cursor \\ :main) do
    with {:ok, tip} <- tip_node(impl, session_id, cursor) do
      slice = Reconstitute.slice_to(impl, tip)
      {:ok, slice_to_tape(slice)}
    end
  end

  @doc """
  Refold an explicit node slice (root-first) into a native tape.

  The slice-level entry point used by the reducer (W4): reduction happens in
  node-space, then projects to tape-space here. Pure over its input — no store
  reads — so a reduced `[Node.t()]` refolds without touching the DAG it came from.
  """
  @spec slice_to_tape([Node.t()]) :: [map()]
  def slice_to_tape(slice) when is_list(slice) do
    Enum.flat_map(slice, &node_to_messages/1)
  end

  # --- internals ---

  defp tip_node(impl, session_id, cursor) do
    with {:ok, session} <- fetch_session(impl, session_id),
         node_id when is_binary(node_id) <-
           Map.get(session.cursors, cursor) || {:error, :no_cursor},
         {:ok, %Node{} = tip} <- Store.fetch(impl, {:node, session_id, node_id}) do
      {:ok, tip}
    else
      {:error, _} = e -> e
      :error -> {:error, :no_session}
      nil -> {:error, :no_cursor}
    end
  end

  defp fetch_session(impl, session_id) do
    case Store.fetch(impl, {:session, session_id}) do
      {:ok, session} -> {:ok, session}
      :error -> {:error, :no_session}
    end
  end

  # One node -> its (optional) user message, then its assistant turn. The
  # assistant turn is a tool exchange when the node ran a program, else bare prose.
  defp node_to_messages(%Node{} = n) do
    user_msgs(n) ++ assistant_msgs(n)
  end

  defp user_msgs(%Node{prompt: prompt}) when is_binary(prompt) and prompt != "" do
    [%{role: :user, content: prompt}]
  end

  defp user_msgs(_), do: []

  # A program-bearing turn -> assistant(tool_use) + tool_result, paired by a
  # deterministic id. A prose-only turn -> a bare assistant message (or nothing).
  defp assistant_msgs(%Node{form_src: src} = n) when is_binary(src) and src != "" do
    id = call_id(n)

    assistant = %{
      # A program turn's native assistant content is the model's prose ALONGSIDE
      # the tool call, which the L1 node does NOT retain separately (`say` is
      # result-derived, per Recorder.extract_say). Using `say` here would replay
      # the tool RESULT as assistant prose — wrong. The faithful reconstruction is
      # an empty assistant content (the common live case: the model emitted only
      # the tool call), with the program carried in the tool_use below. (PLAN-018
      # W3, S3 swarm finding.)
      role: :assistant,
      content: "",
      tool_calls: [
        %{
          "id" => id,
          "type" => "function",
          "function" => %{
            "name" => @lisp_eval_name,
            "arguments" => %{"program" => src}
          }
        }
      ]
    }

    tool = %{role: :tool, tool_call_id: id, content: result_content(n.status, n.result)}

    [assistant, tool]
  end

  defp assistant_msgs(%Node{say: say}) when is_binary(say) and say != "" do
    [%{role: :assistant, content: say}]
  end

  defp assistant_msgs(_), do: []

  # Deterministic native call id for a node: same node -> same id every refold, so
  # the produced tape is byte-stable (the determinism invariant). Prefixed so it
  # never collides with a live provider-issued id.
  defp call_id(%Node{id: id}), do: "call_" <> id

  # Render a node's recorded result to the tool_result block content. The LIVE
  # loop wraps each result in a PtcToolProtocol envelope (status + result +
  # prints/feedback/memory deltas) before sending it; the L1 node does NOT retain
  # that envelope (it keeps only the bare `result` + `status`), so a byte-identical
  # reproduction is impossible from L1 alone. We reconstruct a MINIMAL faithful
  # envelope — {"status", "result"} — so the replayed tape is provider-valid and
  # carries the same load-bearing signal (did the turn succeed, and what did it
  # return) the model needs, without inventing the unstored fields. (PLAN-018 W3,
  # S3 swarm finding: do not pass the raw result as if it were the live payload.)
  defp result_content(status, result) do
    Jason.encode!(%{"status" => Atom.to_string(status || :ok), "result" => jsonable(result)})
  end

  # Coerce an arbitrary recorded result into a JSON-encodable term. A binary, nil,
  # number, boolean, list, or map passes through; anything Jason cannot encode
  # (an atom other than nil/booleans, a tuple, a PID, ...) degrades to its
  # inspected string rather than raising — refold must never crash on a valid
  # recorded history (a PTC turn can `(return :some_atom)`). (PLAN-018 W3, S3
  # swarm finding.)
  defp jsonable(term) do
    case Jason.encode(term) do
      {:ok, _} -> term
      {:error, _} -> inspect(term)
    end
  end
end
