defmodule SpellAgent.Hist.Namespace do
  @moduledoc """
  The `hist/*` PTC-Lisp tool namespace (PLAN-001, W4) — the homoiconic payoff.

  Just as `SpellAgent.Harness` exposes `harness/*` (pure gaze transforms) and
  `keymap/*` (live rebinding) as a string→fn tool map merged into the agent's
  tools, this module exposes `hist/*` so the agent interrogates and operates on its
  OWN conversation history in the same language it thinks in. History becomes a
  first-class tool surface alongside `tool/*` and `harness/*`.

  The verbs are thin adapters over the capability modules, closing over a
  `Hist.Store` impl + the current `session_id`:

      (hist/env {})                      ; reconstituted def-env at the cursor (C1)
      (hist/tools {})                    ; runtime-authored tools live now (C1/C3)
      (hist/messages {})                 ; the chat-lens slice (C1)
      (hist/tool_calls {:name "edit" :status "error"})  ; realized tool calls, filtered (C4, PTC lens)
      (hist/forms {:tool "edit"})        ; turns whose program calls (tool/edit ...) (C4, PTC lens)
      (hist/defs {:sym "plan"})          ; where a symbol was defined (C4, PTC lens)
      (hist/provenance {:sym "plan"})    ; where `plan` was FIRST bound + later rebinds (FUP-001 lens)
      (hist/form_tree {:within "let" :find "tool_call"})  ; structural query over the program AST (FUP-002 lens)
      (hist/cost {})                     ; token spend across the session (C4/C5, PTC lens)
      (hist/lens {:source "(->> data/nodes ...)"})  ; run an AGENT-AUTHORED lens (PLAN-005)
      (hist/forms! {...})                ; the Elixir fast-path / parity oracle for any lens
      (hist/sessions {})                 ; all sessions, open + past, enriched (PLAN-010)
      (hist/trace {:session "<id>"})     ; a session's conversation trace as node rows (PLAN-010)
      (hist/spans {:node "<id>"})        ; the execution interior of a turn (C5)
      (hist/window {:keep 3})            ; the compacted view; trimmed stay in store (C6)
      (hist/recall {:like "postgres"})   ; pull a trimmed turn back (C6)
      (hist/inventory {})                ; authored-tool inventory + usage (C3)
      (hist/promote {:tool "blast"})     ; session tool -> durable (C3)
      (hist/crystallize {:nodes [...] :name "hot" :source "..."})  ; slice -> Crystal (C2)

  Results are plain data (maps/lists), so a program pipes them like any tool
  result. A recall query is itself a PTC-Lisp program — the substrate and the
  stored thing speak one tongue.
  """

  alias SpellAgent.Hist.{Crystallize, Lens, Query, Reconstitute, Reduce, Refold, Spans, Tools, Window}
  alias SpellAgent.Hist.Store

  @doc """
  The `hist/*` tool entries (qualified-name => `(args -> value)`), to merge into
  the tools map a session runs with. Closes over the `impl` store module and the
  `session_id` whose history these verbs read.
  """
  @spec tools(module(), String.t()) :: %{optional(String.t()) => (map() -> term())}
  def tools(impl, session_id) do
    # The PURE query lenses ship as PTC-Lisp (PLAN-005): hist/forms, hist/defs,
    # hist/tool_calls, hist/cost + hist/lens (runtime authorship). They take the
    # primary names. The Elixir Query verbs are kept under a `!` suffix as fast
    # paths and parity oracles. Everything else (state/effect/invariant verbs)
    # stays Elixir per the PLAN-004 boundary.
    elixir = %{
      "hist/env" => fn _args -> reconstitute_field(impl, session_id, :env) end,
      "hist/tools" => fn _args -> reconstitute_field(impl, session_id, :tools) end,
      "hist/messages" => fn _args -> reconstitute_field(impl, session_id, :messages) end,
      "hist/find!" => fn args -> Query.tool_calls(impl, session_id, find_opts(args)) end,
      "hist/forms!" => fn args -> forms(impl, session_id, args) end,
      "hist/def!" => fn args -> Query.defq(impl, session_id, arg(args, "sym")) end,
      "hist/provenance!" => fn args -> provenance(impl, session_id, arg(args, "sym")) end,
      "hist/cost!" => fn args -> Query.cost(impl, session_id, cost_opts(args)) end,
      "hist/sessions" => fn _args -> sessions(impl) end,
      "hist/trace" => fn args -> trace(impl, session_id, args) end,
      "hist/spans" => fn args -> spans(impl, session_id, args) end,
      "hist/window" => fn args -> window(impl, session_id, args) end,
      "hist/recall" => fn args -> Window.recall(impl, session_id, arg(args, "like") || "") end,
      "hist/inventory" => fn _args -> inventory(impl, session_id) end,
      "hist/promote" => fn args -> promote(impl, args) end,
      "hist/crystallize" => fn args -> crystallize(impl, session_id, args) end,
      # PLAN-018 W3: refold the node DAG back into a replayable native tape (the
      # high-fidelity inverse of Recorder; NOT the lossy chat lens). Returns the
      # message list, or an {"err" ...} map mirroring the other reconstitute verbs.
      "hist/refold" => fn args -> refold(impl, session_id, args) end,
      # PLAN-018 W3: the cheap reducibility ESTIMATE (tok_full/tok_reduced/
      # reducible_tokens) the rate-controller reads. Runs the reducibility.ptc
      # policy over the projection — estimate only, no reduction, no inference.
      "hist/reducibility" => fn args -> reducibility(impl, session_id, args) end,
      # PLAN-018 W4: run the LOSSLESS reduction fold and return the reduced
      # replayable tape. Reduces in node-space (dead-bind-elim, tool-cse,
      # stale-read-collapse, print-prune) then refolds to native messages. The
      # def-env is provably preserved (fold_env(reduced) == fold_env(full)).
      # PLAN-018 W6: pass {:tier "lossy"} to also spill over-threshold restorable
      # results to re-fetchable stubs (the tape-shedding tier).
      "hist/reduce" => fn args -> reduce(impl, session_id, args) end,
      # PLAN-018 W6: the tail goal-restatement (todo.md analogue) to APPEND after
      # the tape — never in the cached prefix. A data projection of the goal +
      # progress, zero inference.
      "hist/recite" => fn args -> recite(impl, session_id, args) end
    }

    Map.merge(elixir, Lens.tools(impl, session_id))
  end

  # --- adapters ---

  defp reconstitute_field(impl, session_id, field) do
    case Reconstitute.at(impl, session_id) do
      {:ok, state} -> Map.get(state, field)
      {:error, reason} -> %{"err" => to_string(reason)}
    end
  end

  defp find_opts(args) do
    []
    |> put_opt(:name, arg(args, "tool"))
    |> put_opt(:status, status_atom(arg(args, "status")))
  end

  defp cost_opts(args) do
    put_opt([], :since_mark, arg(args, "since_mark"))
  end

  defp forms(impl, session_id, args) do
    # `{:tool name}` matches a Lisp tool call; `{:shell head}` matches a shell
    # command head run via tool/sh or tool/sh-pipe (PLAN-011 W6). Dispatch order
    # (shell first) and the non-empty-string guard MUST match priv/hist/lenses/
    # forms.ptc exactly, or the Elixir fast path and the PTC lens diverge for the
    # same args (the parity contract). A blank/non-string arg is not a matcher.
    shell = arg(args, "shell")
    tool = arg(args, "tool")

    cond do
      is_binary(shell) and shell != "" -> Query.forms(impl, session_id, {:shell, shell})
      is_binary(tool) and tool != "" -> Query.forms(impl, session_id, {:tool_call, tool})
      true -> []
    end
  end

  # FUP-001 parity oracle: the Elixir twin of provenance.ptc. Same string-keyed
  # shape, so a test can assert hist/provenance == hist/provenance! exactly.
  # Reads the projected `introduced`/`bound` sets the lens sees, in seq order.
  defp provenance(_impl, _session_id, nil), do: %{"err" => "sym required"}

  defp provenance(impl, session_id, sym) when is_binary(sym) do
    nodes = Lens.project(impl, session_id)

    origin =
      Enum.find(nodes, fn n -> sym in (n["introduced"] || []) end)

    rebound =
      nodes
      |> Enum.filter(fn n ->
        sym in (n["bound"] || []) and sym not in (n["introduced"] || [])
      end)
      |> Enum.map(fn n -> %{"id" => n["id"], "seq" => n["seq"]} end)

    %{
      "sym" => sym,
      "introduced_at" => origin && %{"id" => origin["id"], "seq" => origin["seq"]},
      "rebound_at" => rebound
    }
  end

  # PLAN-010: the unified session listing (open + past) as plain data. Reads the
  # live tracker via SessionList's default, so the agent sees what is running now
  # alongside what was recorded.
  defp sessions(impl) do
    SpellAgent.Hist.SessionList.rows(store: impl)
  end

  # PLAN-010: a session's conversation trace as node rows. Defaults to THIS
  # session when no :session arg is given, so `(hist/trace {})` reads the current
  # conversation; pass `{:session "id"}` to read another. Interior rows for a
  # node are one `(hist/spans {:node id})` away.
  defp trace(impl, session_id, args) do
    target = arg(args, "session") || session_id
    SpellAgent.Hist.Trace.rows(impl, target)
  end

  defp spans(impl, session_id, args) do
    case arg(args, "node") do
      nil ->
        []

      nid ->
        case Store.fetch(impl, {:node, session_id, nid}) do
          {:ok, node} -> %{spans: Spans.spans(node), cost: Spans.cost(node)}
          :error -> %{"err" => "no such node"}
        end
    end
  end

  defp window(impl, session_id, args) do
    keep = arg(args, "keep") || 3

    case Window.window(impl, session_id, keep_recent: keep) do
      {:ok, %{shown: shown, trimmed: trimmed}} ->
        %{shown: Enum.map(shown, & &1.id), trimmed: Enum.map(trimmed, & &1.id)}

      {:error, reason} ->
        %{"err" => to_string(reason)}
    end
  end

  # inventory/promote reach SpellAgent.ToolRegistry (a GenServer); if it isn't
  # running, Agent.get EXITS :noproc and would crash the PTC sandbox. Guard with
  # a registered-process check and normalize all failures to an error map
  # (BUG-003 B3, B4) so these verbs always return data.
  defp inventory(impl, session_id) do
    require_registry(fn -> Tools.inventory(impl, session_id) end)
  end

  defp promote(impl, args) do
    case arg(args, "tool") do
      nil ->
        %{"err" => "tool name required"}

      name ->
        require_registry(fn -> normalize_err(Tools.promote(impl, name)) end)
    end
  end

  defp require_registry(fun) do
    if Process.whereis(SpellAgent.ToolRegistry),
      do: fun.(),
      else: %{"err" => "tool registry not running"}
  end

  defp normalize_err({:error, reason}), do: %{"err" => to_string(reason)}
  defp normalize_err(other), do: other

  defp crystallize(impl, session_id, args) do
    node_ids = arg(args, "nodes") || []
    name = arg(args, "name")
    source = arg(args, "source")

    cond do
      is_nil(name) ->
        %{"err" => "name required"}

      is_binary(source) ->
        do_crystallize(impl, session_id, node_ids, name, source, args)

      true ->
        # No explicit source: derive the deterministic slice source from the nodes.
        derived = Crystallize.slice_source(impl, session_id, node_ids)
        do_crystallize(impl, session_id, node_ids, name, derived, args)
    end
  end

  defp do_crystallize(impl, session_id, node_ids, name, source, args) do
    attrs = %{name: name, signature: arg(args, "signature"), compile: {:source, source}}

    case Crystallize.crystallize(impl, session_id, node_ids, attrs) do
      {:ok, crystal} -> crystal
      {:error, reason} -> %{"err" => to_string(reason)}
    end
  end

  # PLAN-018 W3: refold the node DAG -> a replayable native tape. `cursor`
  # defaults to :main. Returns a plain message list (JSON-able) so a program pipes
  # it like any tool result; an error becomes an {"err" ...} map, never a raise.
  defp refold(impl, session_id, args) do
    case Refold.to_tape(impl, session_id, cursor_arg(args)) do
      {:ok, tape} -> tape
      {:error, reason} -> %{"err" => to_string(reason)}
    end
  end

  # PLAN-018 W3: run the reducibility ESTIMATE policy over the projection. A thin
  # pass-through to the reducer .ptc via Lens.run (estimate only, no reduction).
  defp reducibility(impl, session_id, args) do
    source = Map.get(Lens.reducer_sources(), "reducibility")
    Lens.run(impl, session_id, source, args || %{})
  end

  # PLAN-018 W6: run the recite policy over the projection -> the tail goal-
  # restatement string. The caller appends it AFTER the tape (post-cache).
  defp recite(impl, session_id, args) do
    source = Map.get(Lens.reducer_sources(), "recite")
    Lens.run(impl, session_id, source, args || %{})
  end

  # PLAN-018 W4: reduce the root->cursor slice (lossless tier) and refold it to a
  # replayable tape. Returns the message list, or an {"err" ...} map on a missing
  # session/cursor (mirrors hist/refold).
  #
  # BEST-EFFORT POSTURE: a malformed node could make Reduce/Refold raise; the
  # mission must degrade to the UNREDUCED refold (or an error map), never crash.
  # We rescue the reduce+refold pipeline and fall back to a plain refold; if even
  # that fails, surface an {"err" ...} map. (L1 swarm finding.)
  defp reduce(impl, session_id, args) do
    cursor = cursor_arg(args)

    case Reconstitute.at(impl, session_id, cursor) do
      {:ok, %{nodes: slice}} -> reduce_or_fallback(slice, tier_arg(args))
      {:error, reason} -> %{"err" => to_string(reason)}
    end
  end

  # The reduction tier: :lossy when the agent asks (over-threshold restorable
  # results spill to stubs), else the default :lossless.
  defp tier_arg(args) do
    case arg(args, "tier") do
      "lossy" -> :lossy
      _ -> :lossless
    end
  end

  defp reduce_or_fallback(slice, tier) do
    reduced = if tier == :lossy, do: Reduce.lossy(slice), else: Reduce.lossless(slice)
    Refold.slice_to_tape(reduced)
  rescue
    _ ->
      # the reducer/refold failed on a malformed node — degrade to the unreduced
      # tape rather than crash the mission (a bad reduction is a worse cache, not
      # a dead agent).
      try do
        Refold.slice_to_tape(slice)
      rescue
        _ -> %{"err" => "reduce+refold failed"}
      end
  end

  # Resolve a :cursor arg to a known atom lane, defaulting to :main. Never mints a
  # new atom from agent input (atom-table safety, same posture as safe_atom_get).
  defp cursor_arg(args) do
    case arg(args, "cursor") do
      "main" -> :main
      :main -> :main
      _ -> :main
    end
  end

  # --- arg helpers ---

  # PTC-Lisp tool args arrive string-keyed; also tolerate an existing atom key
  # (never CREATE one — String.to_atom on tool input would reopen atom-table
  # growth, the vuln PtcRunner's SourceAtoms guards against).
  defp arg(args, key) when is_map(args) do
    case Map.fetch(args, key) do
      {:ok, v} -> v
      :error -> safe_atom_get(args, key)
    end
  end

  defp arg(_args, _key), do: nil

  defp safe_atom_get(args, key) do
    atom = String.to_existing_atom(key)
    Map.get(args, atom)
  rescue
    ArgumentError -> nil
  end

  defp put_opt(opts, _key, nil), do: opts
  defp put_opt(opts, key, value), do: Keyword.put(opts, key, value)

  defp status_atom("ok"), do: :ok
  defp status_atom("error"), do: :error
  defp status_atom(s) when s in [:ok, :error], do: s
  defp status_atom(_), do: nil
end
