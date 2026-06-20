defmodule SpellAgent.Hist.Recorder do
  @moduledoc """
  Turn a `PtcRunner.Step` (a completed SubAgent mission) into a chain of persisted
  `Hist.Node`s (PLAN-001, C1 write path).

  ## What it captures

  `Step.turns` is the list of `PtcRunner.Turn`s, each one LLM cycle: the emitted
  `program`, the `result`, captured `prints`, the `tool_calls`, and the cumulative
  `memory` (the def env AFTER that turn). The recorder:

    1. Reads each turn's env DELTA from the runtime-emitted `turn.def_delta`
       (MOVE-A/A') — `introduced ∪ changed` — so a node stores only what its
       form introduced (the prior env lives in ancestor nodes). Synthetic turns
       with no def_delta fall back to a snapshot diff (`map_delta/2`).
    2. Receives an already-frozen Step: handles are realized AT THE OWNER by
       `PtcRunner.Step.freeze/1` (in `SpellAgent.Session`) before recording, so
       no live handle is ever persisted (PLAN-008 SEAM 2). The continuation tape
       — not part of the Step — is realized here via `Handle.deep_realize/1`.
    3. Content-addresses the node (`Hist.Id.node_id/2`) and links it to its parent,
       forming the branch DAG in `parent_id`.
    4. Indexes the content hash (`{:hash, h}`) for dedup / multi-session union.
    5. Advances the session's `:main` cursor to the last node.

  Pure persistence — no telemetry coupling here (the live span tee is a separate
  W2 concern). This path is what `SpellAgent.Session` calls after a run to make the
  mission durable.
  """

  alias PtcRunner.Lisp.CoreToSource
  alias PtcRunner.Lisp.Handle
  alias SpellAgent.Hist.{Cont, Id, Node, Session}
  alias SpellAgent.Hist.Store

  @doc """
  Persist a completed `step` under `session_id`. Creates the `Session` record if
  absent, appends one `Node` per turn, and returns the final `:main` cursor node id.

  Options:
    * `:prompt` — opening user prompt (stored on the Session)
    * `:model`  — model id (stored on the Session)
    * `:parent` — node id to attach the first turn under (resume/branch); defaults
      to the session's current `:main`, or nil for a fresh root.
  """
  @spec record_step(module(), String.t(), PtcRunner.Step.t(), keyword()) :: String.t() | nil
  def record_step(impl, session_id, %PtcRunner.Step{} = step, opts \\ []) do
    session = ensure_session(impl, session_id, opts)
    start_parent = Keyword.get(opts, :parent, session.cursors[:main])
    turns = step.turns || []

    # PtcRunner numbers every run's turns from 1, so a second step appended to the
    # same session would reuse seq 1,2,3 (BUG-001 B2). Offset by the session's
    # current max seq so seq is monotonic across steps.
    seq_offset = max_seq(impl, session_id)

    # The user prompt opens the step, so only the HEAD turn (idx == 1) carries it;
    # interior turns leave Node.prompt nil. This is what lets the chat lens
    # interleave a faithful user->assistant transcript across runs.
    prompt = Keyword.get(opts, :prompt)

    {last_id, _prev_mem} =
      turns
      |> Enum.with_index(1)
      |> Enum.reduce({start_parent, parent_memory(impl, session_id, start_parent)}, fn {turn, idx},
                                                                                       {parent_id,
                                                                                        prev_mem} ->
        turn = if idx == 1, do: Map.put(turn, :prompt, prompt), else: turn
        node = build_node(session_id, turn, parent_id, prev_mem, seq_offset + idx)
        persist_node(impl, node)
        {node.id, turn.memory || %{}}
      end)

    if last_id,
      do:
        Store.put(impl, {:session, session_id}, %{
          session
          | cursors: Map.put(session.cursors, :main, last_id)
        })

    # L0 continuation buffer (PLAN-006): persist the verbatim replay tape + the
    # threaded def env beside the L1 nodes, so the NEXT turn can feed the model
    # the real conversation (tool calls + results intact), not the lossy chat
    # lens. Single-valued per session, overwritten each turn. Handle-free before
    # persist, same invariant as a Node. Absent opts => no-op (a synthetic/test
    # record that has no live tape leaves any prior Cont untouched).
    maybe_record_cont(impl, session_id, opts)

    last_id
  end

  # Write {:cont, sid} from the run's collected messages + final memory. Only
  # fires when a tape was actually captured (collect_messages: true upstream); a
  # record call without :tape leaves the continuation buffer as-is.
  defp maybe_record_cont(impl, session_id, opts) do
    case Keyword.get(opts, :tape) do
      tape when is_list(tape) and tape != [] ->
        cont = %Cont{
          session: session_id,
          tape: Handle.deep_realize(strip_system(tape)),
          memory: Handle.deep_realize(Keyword.get(opts, :memory, %{}) || %{}),
          t: System.system_time(:millisecond)
        }

        Store.put(impl, {:cont, session_id}, cont)

      _ ->
        :ok
    end
  end

  # The system prompt is regenerated every turn by the loop, so it must NOT live
  # in the stored tape (it would double up on replay and pin a stale prompt).
  defp strip_system(tape) do
    Enum.reject(tape, fn msg ->
      Map.get(msg, :role) == :system or Map.get(msg, "role") == "system"
    end)
  end

  @doc """
  Record a single node directly (used by tests, the live tee, and synthetic
  history). Content-addresses, links to `parent_id`, indexes the hash. The caller
  is responsible for passing handle-free data (live runs freeze upstream via
  `PtcRunner.Step.freeze/1`). Returns the stored node.
  """
  @spec record_node(module(), String.t(), map(), String.t() | nil) :: Node.t()
  def record_node(impl, session_id, attrs, parent_id) do
    _ = ensure_session(impl, session_id, [])
    prev_mem = parent_memory(impl, session_id, parent_id)
    seq = max_seq(impl, session_id) + 1
    turn = Map.merge(synthetic_turn(), Map.put(attrs, :number, seq))
    node = build_node(session_id, turn, parent_id, prev_mem, seq)
    persist_node(impl, node)
    node
  end

  # --- internals ---

  defp build_node(session_id, turn, parent_id, prev_mem, seq) do
    # SEAM 1 (PLAN-008): the env delta a turn introduced is now emitted AT THE
    # SOURCE by the runtime (MOVE-A, projected onto the Turn by MOVE-A'). Read
    # `turn.def_delta` (introduced ∪ changed) directly; fall back to a snapshot
    # diff only for synthetic/legacy turns that carry no def_delta (record_node).
    binds = binds_of(turn, prev_mem)
    # FUP-001 (PLAN-008): the names this turn FIRST defined (def_delta.introduced).
    # A pure projection of the runtime delta — provenance ("where was x first
    # bound?") becomes an O(chain) scan with no env folding.
    introduced = introduced_of(turn, prev_mem)
    # SEAM 3 (PLAN-008): the executed CoreAST is on the Turn (MOVE-C/C'), so the
    # node's `form` is real structure a lens can walk — not the re-parsed source
    # string. `form_src` stays the human-readable source for display. Synthetic
    # turns (no `form`) fall back to the program string.
    form = turn_form(turn)
    form_src = render(turn.program)
    id = Id.node_id(form_src, parent_id)

    # SEAM 2 (PLAN-008): handles are realized AT THE OWNER by `Step.freeze/1`
    # (called in Session.record_history before recording) while the parked term
    # is guaranteed live, so the node fields below are already handle-free — no
    # `Realize.walk` race on the write path.
    %Node{
      id: id,
      session: session_id,
      parent_id: parent_id,
      seq: seq,
      kind: :turn,
      status: status_of(turn),
      prompt: Map.get(turn, :prompt),
      form: form,
      form_src: form_src,
      binds: binds,
      introduced: introduced,
      result: turn.result,
      sees: turn.tool_calls || [],
      prints: turn.prints || [],
      say: extract_say(turn),
      raw_response: turn.raw_response,
      tools_defined: tools_defined(turn),
      span_root: Map.get(turn, :span_root, nil),
      tokens: Map.get(turn, :tokens, nil),
      t: System.system_time(:millisecond)
    }
  end

  # Highest seq currently recorded for a session (0 when empty). Monotonic seq
  # assignment uses this so appended steps/nodes never collide (BUG-001 B2).
  defp max_seq(impl, session_id) do
    impl
    |> Store.list(:node, session_id)
    |> Enum.map(& &1.seq)
    |> Enum.max(fn -> 0 end)
  end

  defp persist_node(impl, %Node{} = node) do
    Store.put(impl, {:node, node.session, node.id}, node)
    index_hash(impl, node)
    node
  end

  defp index_hash(impl, %Node{id: id, session: session}) do
    ref = {session, id}

    refs =
      case Store.fetch(impl, {:hash, id}) do
        {:ok, list} when is_list(list) -> Enum.uniq([ref | list])
        _ -> [ref]
      end

    Store.put(impl, {:hash, id}, refs)
  end

  defp ensure_session(impl, session_id, opts) do
    case Store.fetch(impl, {:session, session_id}) do
      {:ok, %Session{} = s} ->
        s

      :error ->
        s = %Session{
          id: session_id,
          prompt: Keyword.get(opts, :prompt),
          model: Keyword.get(opts, :model),
          t0: System.system_time(:millisecond),
          cursors: %{}
        }

        Store.put(impl, {:session, session_id}, s)
        s
    end
  end

  defp parent_memory(_impl, _session_id, nil), do: %{}

  defp parent_memory(impl, session_id, parent_id) do
    case Store.fetch(impl, {:node, session_id, parent_id}) do
      {:ok, node} -> cumulative_memory(impl, node)
      :error -> %{}
    end
  end

  # The cumulative env at a node = fold binds from root to it. Cheap here because
  # binds are deltas; ancestors are walked via parent_id.
  defp cumulative_memory(impl, %Node{} = node) do
    chain = ancestor_chain(impl, node, [])
    Enum.reduce(chain, %{}, fn n, acc -> Node.apply_binds(acc, n.binds) end)
  end

  defp ancestor_chain(_impl, %Node{parent_id: nil} = n, acc), do: [n | acc]

  defp ancestor_chain(impl, %Node{parent_id: pid} = n, acc) do
    case Store.fetch(impl, {:node, n.session, pid}) do
      {:ok, parent} -> ancestor_chain(impl, parent, [n | acc])
      :error -> [n | acc]
    end
  end

  # SEAM 1 (PLAN-008): `binds` is now sourced from the runtime-emitted
  # `turn.def_delta` (introduced ∪ changed). `binds_of/2` reads it when present
  # and falls back to `map_delta/2` for SYNTHETIC turns only (record_node /
  # synthetic_turn, the live tee, tests) that carry no def_delta.
  defp binds_of(turn, prev_mem) do
    case Map.get(turn, :def_delta) do
      %{introduced: intro, changed: chg} ->
        Map.merge(intro || %{}, chg || %{})

      _ ->
        map_delta(prev_mem, turn.memory || %{})
    end
  end

  # FUP-001 (PLAN-008): the names a turn FIRST introduced, as strings, from the
  # runtime delta (`def_delta.introduced` keys). For a synthetic turn with no
  # def_delta, derive it the only honest way: keys present AFTER but absent from
  # the entering env (a first binding). Returns binary names to match the
  # source-emitted contract (0.12 def names are binary).
  defp introduced_of(turn, prev_mem) do
    case Map.get(turn, :def_delta) do
      %{introduced: intro} when is_map(intro) ->
        intro |> Map.keys() |> Enum.map(&to_string/1)

      _ ->
        mem = turn.memory || %{}

        mem
        |> Map.keys()
        |> Enum.reject(&Map.has_key?(prev_mem, &1))
        |> Enum.map(&to_string/1)
    end
  end

  # SEAM 3 (PLAN-008): prefer the executed CoreAST (`turn.form`, MOVE-C') so a
  # lens walks real structure; synthetic turns with no form keep the program
  # value (a string) so the node still renders.
  defp turn_form(turn), do: Map.get(turn, :form) || turn.program

  # The introduced-or-changed env delta a turn made vs the env entering it. Used
  # ONLY as the synthetic-turn fallback now (live turns carry `def_delta`). There
  # is NO deletion arm: PTC has no `undef`, so a run can only add or rebind a
  # name — a delta can never express removal-by-omission (the BUG-001 B1 class is
  # now unrepresentable, not merely fixed). `Map.fetch` distinguishes an absent
  # key from a present nil, so `(def x nil)` is recorded.
  defp map_delta(before, after_) do
    Enum.reduce(after_, %{}, fn {k, v}, acc ->
      case Map.fetch(before, k) do
        {:ok, ^v} -> acc
        _ -> Map.put(acc, k, v)
      end
    end)
  end

  defp render(nil), do: nil

  defp render(program) when is_binary(program), do: program

  defp render(program) do
    try do
      CoreToSource.format(program)
    rescue
      _ -> inspect(program)
    end
  end

  defp status_of(%{success?: false}), do: :error
  defp status_of(%{type: :retry}), do: :retry
  defp status_of(_), do: :ok

  defp extract_say(%{result: result}) when is_binary(result), do: result
  defp extract_say(_), do: nil

  defp tools_defined(%{tool_calls: calls}) when is_list(calls) do
    calls
    |> Enum.filter(&(&1[:name] in ["define-tool", "tool/define-tool"]))
    |> Enum.map(fn c -> get_in(c, [:args, "name"]) || get_in(c, [:args, :name]) end)
    |> Enum.reject(&is_nil/1)
  end

  defp tools_defined(_), do: []

  # A minimal Turn-shaped map for synthetic/test nodes.
  defp synthetic_turn do
    %{
      number: 0,
      program: nil,
      result: nil,
      prints: [],
      tool_calls: [],
      memory: %{},
      raw_response: nil,
      success?: true,
      type: :normal
    }
  end
end
