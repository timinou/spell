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

  alias SpellAgent.{Anthropic, Config, Hist, Mesh, Tools}

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
    model = opts[:model] || Config.get("model")
    max_turns = opts[:max_turns] || 12
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
    %{tape: tape, memory: memory} = load_continuation(session_id, hist_store)

    agent =
      PtcRunner.SubAgent.new(
        prompt: prompt,
        system_prompt: system_prompt(),
        # SEAM 5: merge the hist/* verbs so the agent can interrogate its OWN past
        # mid-conversation ((hist/cost {}), (hist/forms {...}), authored lenses).
        # PROJ-006: when this session coordinates in a mesh `region`, also merge the
        # black/* verbs (the same injection seam) so it can post/query/claim/fold on
        # the shared blackboard. No region -> Mesh.verbs returns %{} (a plain session).
        tools:
          Tools.build_tools_map()
          |> Map.merge(Hist.verbs(session_id, store: hist_store))
          |> Map.merge(Mesh.verbs(session_id, region: opts[:region], store: hist_store))
          # A2 (PLAN-014): the clock/* self-wake verbs. A wake defaults to running
          # in THIS session, so the mind can schedule its own continuation.
          |> Map.merge(SpellAgent.Clock.Namespace.tools(session_id)),
        # PLAN-020 W7: attach the q/* structural-transform prelude so the agent can
        # author codemods inline ((q/update (tool/code-parse {...}) pattern f),
        # (q/apply-ops ...)) and walk source/shell/history with one algebra. nil
        # when the prelude fails to compile (best-effort) -> agent runs without q/*.
        runtime_prelude: SpellAgent.Code.Prelude.compiled(),
        ptc_transport: :tool_call,
        max_turns: max_turns
      )

    # `collect_messages: true` makes the loop populate `step.messages` (the full
    # tape including tool_use/tool_result blocks) so this turn becomes the next
    # turn's replay. `initial_messages`/`initial_memory` feed the prior tape +
    # env IN, closing the loop.
    result =
      PtcRunner.SubAgent.run(agent,
        llm: llm,
        collect_messages: true,
        initial_messages: tape,
        initial_memory: memory
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

  @doc """
  Assemble the system prompt: the base prompt + the freeform-TUI prelude
  (PLAN-009, reflected) + any live `system-addendum` config.

  The freeform prelude is ALWAYS injected (the capability is generally available),
  and is reflected from the widget registry so it never drifts from ex_ratatui.
  Lazy surfacing (inject only on first UI-intent) is FUP-008.
  """
  @spec system_prompt() :: String.t()
  def system_prompt do
    base = @system_prompt <> "\n\n" <> SpellAgent.Tui.Prelude.text()

    case Config.get("system-addendum") do
      add when is_binary(add) and add != "" -> base <> "\n\n" <> add
      _ -> base
    end
  end
end
