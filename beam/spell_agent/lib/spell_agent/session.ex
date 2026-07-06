defmodule SpellAgent.Session do
  @moduledoc """
  Ties the pieces into a runnable, node-free agent turn (FEAT-827, PLAN-344):

    credential (agent.db) → Anthropic subscription adapter → PtcRunner.SubAgent
    loop → homoiconic tools (registry + define-*) → answer.

  The agent runs in `ptc_transport: :tool_call` mode: the model writes PTC-Lisp
  programs that call `(tool/…)`, and EVERY tool — the `define-*` meta-tools and
  any tool the agent defines at runtime — resolves through the same registry-
  backed tools map. So a tool authored mid-conversation is immediately callable.
  """

  alias SpellAgent.{Anthropic, Config, Hist, Tools}

  # The agent system prompt lives in a static .md file (AGENTS.md: prompts
  # live in static files, never inline heredocs). Loaded at compile via
  # @external_resource so a prompt edit triggers recompile, not a code change.
  @system_prompt_path Path.join([
                        :code.priv_dir(:spell_agent) |> to_string(),
                        "prompts",
                        "system.md"
                      ])
  @external_resource @system_prompt_path
  @system_prompt File.read!(@system_prompt_path)

  @doc """
  Run a single mission to completion and return `{:ok, result}` or
  `{:error, reason}`. `result` is the agent's `step.return` (its final value).

  Options:
    * `:model`     — model id (default: live `Config.get("model")`).
    * `:max_turns` — turn budget (default: 12).
    * `:llm`       — an LLM callback `(map() -> {:ok, map()} | {:error, term()})`
      or a `PtcRunner.SubAgent` llm registry atom. Injectable so the inspector
      TUI and tests can drive a FAKE llm with zero network. Defaults to the real
      Anthropic subscription adapter.
  """
  @spec run(String.t(), keyword()) :: {:ok, term()} | {:error, term()}
  def run(prompt, opts \\ []) when is_binary(prompt) do
    # FEAT-045: A4 self-continuation. Run the mission; if its terminal value is a
    # `loop/continue` signal, RE-ENTER with the mind-authored next prompt (same
    # session — the tape continues), bounded by a continue-depth cap so a runaway
    # self-loop is impossible regardless of the token budget. `continues_left`
    # threads the remaining depth; the SAME opts (session_id, budget) carry
    # forward so every continued turn is budget-enforced (FEAT-043).
    # PIN the session id up front (review S4 P2): every continue in the chain must
    # run in the SAME session so the tape + def-env carry forward. A bare
    # Session.run (no :session_id) otherwise mints a fresh id per continue and
    # loses the conversation. Also pin ONE chain budget so the continues SHARE the
    # ceiling instead of re-granting it each time (review S4 P1).
    opts =
      opts
      |> Keyword.put_new(:session_id, Hist.new_session_id())

    run_with_continue(prompt, opts, SpellAgent.Loop.max_continues())
  end

  # The self-continuation trampoline. Each iteration runs ONE mission; a
  # `{:continue, next_prompt}` terminal signal re-enters with the next prompt, a
  # decremented depth, AND a shrunk chain budget so the whole chain shares the
  # original turn/token ceiling rather than re-granting it per continue (review S4
  # P1). Depth exhaustion ends the chain with the last result plus a surfaced note
  # (never a silent stall). Non-continue results pass through.
  defp run_with_continue(prompt, opts, continues_left) do
    result = run_mission(prompt, opts)

    with {:ok, value} <- result,
         {:continue, next_prompt} <- SpellAgent.Loop.signal(value) do
      if continues_left > 0 do
        run_with_continue(next_prompt, shrink_budget(opts, continues_left), continues_left - 1)
      else
        # The runaway guard fired: stop the chain, surface why (the mind asked to
        # continue but the depth cap is reached), returning the request so the
        # caller sees the loop was intentionally halted, not silently dropped.
        {:ok,
         %{
           "loop_halted" => "continue-depth cap (#{SpellAgent.Loop.max_continues()}) reached",
           "pending_prompt" => next_prompt
         }}
      end
    else
      _ -> result
    end
  end

  # Shrink the chain's remaining token/turn budget for the NEXT continue so the
  # whole chain shares the original ceiling (review S4 P1). We cannot cheaply
  # measure the just-consumed amount, so we divide the REMAINING budget by the
  # remaining continue slots — a conservative amortization that guarantees the sum
  # across the chain never exceeds the original ceiling, and the per-continue
  # allowance shrinks toward the tail. An unbounded axis (nil) stays unbounded
  # (the depth cap still bounds the chain count).
  defp shrink_budget(opts, continues_left) do
    opts
    |> shrink_axis(:max_tokens, continues_left)
    |> shrink_axis(:cost_ceiling, continues_left)
    |> shrink_axis(:max_turns, continues_left)
  end

  defp shrink_axis(opts, key, continues_left) do
    case Keyword.get(opts, key) do
      n when is_integer(n) and n > 0 ->
        Keyword.put(opts, key, max(1, div(n * (continues_left - 1), continues_left)))

      _ ->
        opts
    end
  end

  # One mission to completion (the former body of run/2).
  @spec run_mission(String.t(), keyword()) :: {:ok, term()} | {:error, term()}
  defp run_mission(prompt, opts) when is_binary(prompt) do
    model = opts[:model] || Config.get("model")
    # FEAT-043: the session's resource ceiling (turns + tokens). max_turns keeps
    # its historical default (12); a token ceiling (`:max_tokens`, or the
    # `:cost_ceiling` a clock wake threads) is now ENFORCED, not dropped. The
    # SubAgent already meters both — this wires the ceiling to those meters.
    budget = SpellAgent.Budget.from_opts(opts)
    max_turns = SpellAgent.Budget.turns(budget, 12)
    llm = opts[:llm] || Anthropic.callback(model)
    # A session id threads the conversation's durable history (PLAN-003 SEAM 1).
    # The TUI passes a stable id so runs append to one conversation; a bare call
    # mints a fresh one. `:hist` selects the store (default per Hist config).
    session_id = opts[:session_id] || Hist.new_session_id()
    hist_store = opts[:hist] || Hist.default_store()

    # PLAN-010: announce this mission as RUNNING so a session listing can show it
    # as "open" while it streams (the Hist store only learns it AFTER the run).
    # Best-effort and self-cleaning: the registry monitors this process, so a
    # crash still unregisters; `finish` below covers the normal exit. Wrapped so
    # a sick registry can never fail the mission (same posture as recording).
    mark_session_live(session_id, prompt, model)

    # SEAM 0 (PLAN-006): load the L0 continuation — the verbatim replay tape +
    # threaded def env from this session's PRIOR turns. This is the wire the TUI
    # was missing: without it every turn starts cold and the agent forgets the
    # conversation (it named itself one thing, then answered as another). Empty
    # for turn 1 (a cold start, exactly right).
    #
    # Best-effort, same posture as recording (SEAM 1): a sick/oversized store must
    # DEGRADE to a cold start, never crash the mission. History is an enhancement,
    # never a dependency of answering.
    %{tape: verbatim_tape, memory: base_memory} = load_continuation(session_id, hist_store)

    # FEAT-036: ACTIVATE the reduction/compaction engine. At this mission boundary
    # the rate-controller decides — zero inference — whether to feed the verbatim
    # tape forward (a P-frame cache) or start from a reduced keyframe (an I-frame),
    # from the cheap reducibility estimate + this session's remaining turn budget.
    # Best-effort: any failure (or auto_reduce off) returns the verbatim tape, so
    # activation can never break a mission. This is what turns the built-but-dormant
    # PLAN-018 engine (Mission.decide + hist/reduce) into a live capability.
    %{tape: tape} =
      SpellAgent.Hist.RateController.run(hist_store, session_id, verbatim_tape, max_turns)

    # S-E (FEAT-018): an optional :inherit_memory map SEEDS the child's def-env
    # (named bindings) WITHOUT inheriting the tape. Memory is pure data, not in
    # the prompt prefix, so threading it is cache-neutral — a spawned child can
    # reuse a binding the parent computed (e.g. (def callers …)) without
    # re-deriving it. seed wins on conflict; absent -> the cold-start default.
    memory =
      case opts[:inherit_memory] do
        seed when is_map(seed) -> Map.merge(base_memory, seed)
        _ -> base_memory
      end

    agent =
      PtcRunner.SubAgent.new(
        prompt: prompt,
        system_prompt: system_prompt(),
        # SEAM 5: merge the hist/* verbs so the agent can interrogate its OWN past
        # mid-conversation ((hist/cost {}), (hist/forms {...}), authored lenses).
        # PROJ-006: when this session coordinates in a mesh `region`, also merge the
        # black/* verbs (the same injection seam) so it can post/query/claim/fold on
        # the shared blackboard. No region -> Mesh.verbs returns %{} (a plain session).
        tools: build_session_tools(session_id, hist_store, llm, max_turns, opts),
        # PLAN-020 W7: attach the q/* structural-transform prelude so the agent can
        # author codemods inline ((q/update (tool/code-parse {...}) pattern f),
        # (q/apply-ops ...)) and walk source/shell/history with one algebra. nil
        # when the prelude fails to compile (best-effort) -> agent runs without q/*.
        runtime_prelude: SpellAgent.Code.Prelude.compiled(),
        # FUP-027: drain the code-edit restore journal IN-WORKER by the program's
        # verdict. A turn that calls code-edit then (fail)s rolls the file back; a
        # successful turn keeps the write. Runs in the same sandbox worker the
        # edit recorded in — the only point with both the journal + verdict.
        on_complete: &SpellAgent.Code.Journal.finalize/1,
        ptc_transport: :tool_call,
        max_turns: max_turns
      )

    # `collect_messages: true` makes the loop populate `step.messages` (the full
    # tape including tool_use/tool_result blocks) so this turn becomes the next
    # turn's replay. `initial_messages`/`initial_memory` feed the prior tape +
    # env IN, closing the loop.
    result =
      PtcRunner.SubAgent.run(
        agent,
        # FEAT-043: the token ceiling is enforced per-turn by the SubAgent budget
        # check (`token_limit` + `on_budget_exceeded: :fail`); exceeding it ends
        # the run with a `:budget_callback_exceeded` error rather than silently
        # over-running. `max_turns` is already applied on the agent struct above.
        [
          llm: llm,
          collect_messages: true,
          initial_messages: tape,
          initial_memory: memory
        ] ++ SpellAgent.Budget.run_opts(budget)
      )

    record_history(result, session_id, hist_store, prompt, model)
    mark_session_done(session_id)

    case result do
      {:ok, step} -> {:ok, step.return}
      {:error, step} -> {:error, step.fail || step.return || :unknown_failure}
    end
  end

  # Register/unregister this run with the live-session tracker. Best-effort: the
  # registry client already no-ops when the registry is down, and we additionally
  # swallow any error here so liveness tracking can never change the outcome of a
  # mission (history/liveness are enhancements, never dependencies of answering).
  defp mark_session_live(session_id, prompt, model) do
    SpellAgent.SessionRegistry.register(session_id, %{prompt: prompt, model: model})
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp mark_session_done(session_id) do
    SpellAgent.SessionRegistry.finish(session_id)
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  # Load the L0 continuation defensively: any store failure yields a cold start.
  defp load_continuation(session_id, store) do
    try do
      Hist.continuation(session_id, store: store)
    rescue
      _ -> %{tape: [], memory: %{}}
    catch
      _, _ -> %{tape: [], memory: %{}}
    end
  end

  # SEAM 1: persist the finished run into durable history, on BOTH success and
  # failure (a failed run is history too). Recording is best-effort — a history
  # write must never change the mission's outcome — so any error is swallowed.
  defp record_history(result, session_id, store, prompt, model) do
    step =
      case result do
        {:ok, s} -> s
        {:error, s} -> s
      end

    if match?(%PtcRunner.Step{}, step) do
      try do
        # PLAN-008 SEAM 2: freeze the Step AT THE OWNER, synchronously here in the
        # post-run path where every parked handle is still live, BEFORE handing
        # it to the recorder. This materializes handles (tombstoning any that are
        # unrealizable) so the recorder no longer races the HandleStore reaper
        # from outside (the old `Hist.Realize.walk` hot path is gone).
        frozen = PtcRunner.Step.freeze(step)
        Hist.record(session_id, frozen, store: store, prompt: prompt, model: model)
      rescue
        _ -> :ok
      catch
        _, _ -> :ok
      end
    end

    :ok
  end

  # Assemble the tools map for a mission. The BASE surface (Tools.build_tools_map:
  # find/sh/define-*/freeform/registry) may be attenuated by opts[:tools] (a
  # capability subset a spawned child was handed, D12); the session's OWN verbs
  # (hist/*, mesh black/*, clock/*, spawn-session/await-session) are ALWAYS merged
  # for this session_id + region, never filtered — attenuation governs only the
  # inherited base tools, so a child can still coordinate + spawn.
  defp build_session_tools(session_id, hist_store, llm, max_turns, opts) do
    base = attenuate_base(Tools.build_tools_map(), opts[:tools])
    # This session's OWN allowed base-tool ceiling: :all for the unrestricted root
    # (opts[:tools] absent), or exactly the base names it holds for an attenuated
    # child. spawn-session clamps a child's :tools to this so capability can only
    # NARROW down the spawn tree (D12) — a child can't grant what it lacks.
    allowed = if is_nil(opts[:tools]), do: :all, else: Map.keys(base)

    # FEAT-035: the session namespaces (hist/ black/ clock/ spawn) are folded from
    # the ONE catalog with a per-session Context, replacing the hand-written
    # Map.merge chain. The Context carries the exact same wiring the chain did:
    # the parent's resolved llm (children inherit it), the hist store, max_turns,
    # the region, and `allowed` — this session's capability ceiling that clock/
    # and spawn/ clamp a child/wake to (D12 / FUP-019: capability only NARROWS
    # down both the spawn and the wake tree).
    ctx = %SpellAgent.Namespace.Context{
      session_id: session_id,
      hist_store: hist_store,
      llm: llm,
      max_turns: max_turns,
      region: opts[:region],
      allowed: allowed,
      # FEAT-043 + review S4 P1: this session's EFFECTIVE enforced ceiling, so
      # spawn/ clamps a child by it. The budget must carry the effective max_turns
      # (which defaults to 12 when unset) — NOT the raw opts where max_turns is nil
      # — else a child could request `budget {turns: 100}` and the clamp would treat
      # the parent's turn axis as unbounded, widening the child past the enforced 12.
      budget: %{SpellAgent.Budget.from_opts(opts) | max_turns: max_turns}
    }

    assembled =
      Map.merge(base, SpellAgent.Namespace.session_tools_map(SpellAgent.Namespace.Catalog.specs(), ctx))

    # FEAT-018 (M5): the mesh/* ergonomic combinators (ask/scatter/gather/mesh-map),
    # shipped as .ptc source. Their bodies call tool/spawn-session etc., so they run
    # with the ASSEMBLED tool map above (which holds the live spawn verbs). The
    # tools_fun closes over `assembled` — the combinators are pure Lisp sugar over
    # the primitives, never a parallel impl. Kept as a POST step (not a catalog
    # fold entry) because it must close over the fully-assembled map.
    Map.merge(assembled, SpellAgent.Mesh.Combinators.verbs(fn -> assembled end))
  end

  # opts[:tools] absent (nil) -> the full base surface; a list of names -> only
  # those base tools (Map.take); anything else -> full surface. An explicit [] is
  # a list, so it correctly yields an empty base subset.
  defp attenuate_base(base, nil), do: base
  defp attenuate_base(base, names) when is_list(names), do: Map.take(base, Enum.map(names, &to_string/1))
  defp attenuate_base(base, _), do: base

  @doc """
  Assemble the system prompt: the base prompt + the freeform-TUI prelude
  (PLAN-009, reflected) + any live `system-addendum` config.

  The freeform prelude is ALWAYS injected (the capability is generally available),
  and is reflected from the widget registry so it never drifts from ex_ratatui.
  Lazy surfacing (inject only on first UI-intent) is FUP-008.
  """
  @spec system_prompt() :: String.t()
  def system_prompt do
    # FEAT-034: the capability description is DERIVED from the namespace registry
    # (via Tools.inventory), so the prompt always reflects the ACTUAL callable
    # surface — including hist/*, black/*, clock/*, the freeform verbs, spawn/await,
    # and any tools defined at runtime. No hand-maintained list to drift.
    base =
      @system_prompt <>
        "\n\n" <> SpellAgent.Namespace.Prompt.capability_text() <>
        "\n\n" <> SpellAgent.Tui.Prelude.text()

    case Config.get("system-addendum") do
      add when is_binary(add) and add != "" -> base <> "\n\n" <> add
      _ -> base
    end
  end
end
