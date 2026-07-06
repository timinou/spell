defmodule SpellAgent.Spawn do
  @moduledoc """
  The ONE spawn gateway (FEAT-044, PLAN-025 W4): every session, however it comes
  to be — an agent's `tool/spawn-session`, a human's TUI submit, a `clock`
  wake — funnels through `create/2` so lineage, capability attenuation, and
  budget clamping are enforced in exactly one place instead of three parallel
  call sites drifting apart.

  ## What this consolidates

  Before FEAT-044, `SpellAgent.Mesh.Spawn.spawn_session/3` computed region +
  attenuation + child budget + `Join.spawn/2` inline. That logic is unchanged
  in substance — this module only gives it ONE home so the human-initiated
  and clock-wake paths (follow-ups; see below) can reuse it instead of
  reimplementing the resolve/clamp/register sequence.

  ## Scope (this wave)

  This wave wires the AGENT path (`Mesh.Spawn.spawn_session/3`) through
  `create/2`, proving the gateway holds the FEAT-011 reflexive-seam contract
  (detached, budget-bounded, capability-attenuated) end to end. The human-TUI
  and clock-wake callers are NOT rewired here — see the module doc's
  "Follow-ups" section; they need call-site-specific decisions (a TUI submit
  has no `parent_sid`, a clock wake has no live caller process to attribute
  ownership to) this task should not guess at.

  ## Best-effort posture

  Lineage registration (`SessionRegistry.register/2`) is an ENHANCEMENT, same
  as today: a down/crashed registry must never block a spawn. `create/2` calls
  it defensively and proceeds regardless of the outcome.

  ## Follow-ups (out of scope for this wave)

  * Live-TUI cockpit (concurrent multi-session view + focus-switch) — needs the
    `app.ex` decomposition (a monolithic single-focus TUI loop today) plus a
    gaze-per-session model; a wave of its own.
  * Human-initiated spawn UI — routing `App.submit/2` through `create/2` so a
    human-started session also gets lineage (`owner: :human`) recorded
    uniformly; needs the TUI decomposition above to land first (the UI must
    be able to hold >1 session to make "spawn another" meaningful).
  * Human-facing mesh (`human/*` verbs) — letting a human observe/steer a
    session's children (list lineage, tap into a child's stream) from the
    TUI; depends on both items above plus a design for how a human addresses
    a specific session in the mesh.
  """

  alias SpellAgent.{Budget, Hist, SessionRegistry}
  alias SpellAgent.Mesh.Region

  @typedoc "Who spawned a session: the unrestricted human root, or a spawning session."
  @type owner :: :human | {:session, String.t()}

  @typedoc """
  Resolved gateway output: everything a caller needs to actually run the child
  (`Session.run/2` opts) plus the lineage it was registered under.
  """
  @type resolved :: %{
          session_id: String.t(),
          region: String.t(),
          owner: owner(),
          parent_id: String.t() | nil,
          intent: String.t(),
          run_opts: keyword()
        }

  @doc """
  Resolve everything a spawn needs and register its lineage — the ONE gateway
  every spawn path should fold through.

  `prompt` is the child's mission / intent. `opts`:

    * `:owner`       — `:human` (default) or `{:session, parent_id}`.
    * `:parent_id`   — the spawning session's id (nil for a root/human spawn).
    * `:region`      — an explicit region id to join, or `nil`/`"auto"` to fork
      a fresh Fork-A region via `Region.fork_a/2` (requires `:parent_id` when
      forking fresh — a root spawn with no region gets `nil` here and the
      caller's own default applies, e.g. `Session.run`'s cold start).
    * `:tools`       — the capability subset requested for the child (a list
      of base-tool names, or `:inherit`/absent for the parent's full ceiling).
    * `:allowed`     — the PARENT's own capability ceiling (`:all` for an
      unrestricted root, or a list) — `:tools` is clamped to this (D12).
    * `:budget`      — the parent's enforced `%SpellAgent.Budget{}` ceiling
      (nil for an unbounded root). The child's requested budget (`:max_turns`
      / `:max_tokens` / `:cost_ceiling`) is clamped to it (FEAT-043).
    * `:store`       — the Hist store (default `Hist.default_store/0`).
    * `:llm`         — the callback to inherit (children reuse the parent's).
    * `:max_turns`   — fallback default turn ceiling when the clamped budget
      leaves turns unbounded (default 12, mirroring `Session.run/2`).
    * `:session_id`  — an explicit child session id (default: minted fresh).

  Returns `%{session_id, region, owner, parent_id, intent, run_opts}` —
  `run_opts` is the exact keyword list a caller hands to `Session.run/2`
  (already carrying `:session_id`, `:region`, `:store`, `:hist`, `:max_turns`,
  `:max_tokens`, `:tools`, `:llm`, `:inherit_memory`). The caller still owns
  actually RUNNING the child (via `Session.run/2` directly, or via
  `Mesh.Join.spawn/2` for the detached-Task + budget-slot posture the agent
  reflexive seam needs) — this gateway resolves + registers, it does not
  itself spawn a process, so it composes with either posture.
  """
  @spec create(String.t(), keyword()) :: resolved()
  def create(prompt, opts \\ []) when is_binary(prompt) do
    owner = opts[:owner] || :human
    parent_id = opts[:parent_id]
    store = opts[:store] || Hist.default_store()
    session_id = opts[:session_id] || Hist.new_session_id()
    region = resolve_region(opts[:region], parent_id, prompt)

    child_tools = attenuate_tools(opts[:tools], opts[:allowed] || :all)
    child_budget = clamp_budget(opts)

    run_opts =
      [
        session_id: session_id,
        region: region,
        store: store,
        hist: store,
        max_turns: Budget.turns(child_budget, opts[:max_turns] || 12)
      ]
      |> maybe_put(:max_tokens, child_budget.max_tokens)
      |> put_tools(child_tools)
      |> maybe_put(:llm, opts[:llm])
      |> maybe_put(:inherit_memory, opts[:inherit_memory])
      |> maybe_put(:model, opts[:model])

    register_lineage(session_id, owner, parent_id, prompt, region)

    %{
      session_id: session_id,
      region: region,
      owner: owner,
      parent_id: parent_id,
      intent: prompt,
      run_opts: run_opts
    }
  end

  # No region / "auto" -> a fresh Fork-A region when a parent is known (an agent
  # spawn always has one); an explicit region id -> join it as-is. A root spawn
  # with no parent and no region leaves `nil` (the caller's own default, e.g.
  # `Session.run`'s cold start with no mesh region at all).
  defp resolve_region(nil, nil, _prompt), do: nil
  defp resolve_region("auto", nil, _prompt), do: nil
  defp resolve_region(nil, parent_id, prompt) when is_binary(parent_id), do: Region.fork_a(prompt, parent_id)

  defp resolve_region("auto", parent_id, prompt) when is_binary(parent_id),
    do: Region.fork_a(prompt, parent_id)

  defp resolve_region("", parent_id, prompt) when is_binary(parent_id), do: Region.fork_a(prompt, parent_id)
  defp resolve_region(id, _parent_id, _prompt) when is_binary(id), do: id
  defp resolve_region({:structured, _} = s, _parent_id, _prompt), do: Region.fork_b(s)
  defp resolve_region({:slug, _} = s, _parent_id, _prompt), do: Region.fork_b(s)
  defp resolve_region(_other, nil, _prompt), do: nil
  defp resolve_region(_other, parent_id, prompt), do: Region.fork_a(prompt, parent_id)

  # D12: the requested :tools subset clamped to the parent's own ceiling. An
  # absent/:inherit request inherits the ceiling as-is (never widens).
  defp attenuate_tools(nil, ceiling), do: clamp_tools(:inherit, ceiling)
  defp attenuate_tools(:inherit, ceiling), do: clamp_tools(:inherit, ceiling)
  defp attenuate_tools(list, ceiling) when is_list(list), do: clamp_tools(Enum.map(list, &to_string/1), ceiling)
  defp attenuate_tools(_other, ceiling), do: clamp_tools(:inherit, ceiling)

  defp clamp_tools(:inherit, ceiling), do: ceiling
  defp clamp_tools(requested, :all) when is_list(requested), do: requested
  defp clamp_tools(requested, ceiling) when is_list(requested) and is_list(ceiling) do
    Enum.filter(requested, &(&1 in ceiling))
  end

  # FEAT-043: the child's requested budget clamped by the parent's enforced
  # ceiling. A nil parent ceiling (root/unbounded) leaves the request as-is.
  # `:requested_budget` is the caller-parsed %Budget{} (a caller with structured
  # args, e.g. Mesh.Spawn's `{:budget {turns ...}}` arg, parses it BEFORE calling
  # the gateway); `:cost_ceiling` is a bare convenience alias for callers with no
  # existing Budget struct (e.g. a clock-wake follow-up).
  defp clamp_budget(opts) do
    requested =
      case opts[:requested_budget] do
        %Budget{} = b -> b
        _ -> Budget.from_opts(max_turns: opts[:requested_max_turns], max_tokens: opts[:cost_ceiling])
      end

    case opts[:budget] do
      %Budget{} = parent -> Budget.clamp(requested, parent)
      _ -> requested
    end
  end

  # Best-effort lineage registration — a down/crashed registry must never block
  # a spawn (same posture as `Session.run`'s own `mark_session_live`).
  defp register_lineage(session_id, owner, parent_id, prompt, region) do
    SessionRegistry.register(session_id, %{
      prompt: prompt,
      owner: owner,
      parent_id: parent_id,
      intent: prompt,
      region: region
    })
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, key, value), do: Keyword.put(opts, key, value)

  defp put_tools(opts, :all), do: opts
  defp put_tools(opts, list) when is_list(list), do: Keyword.put(opts, :tools, list)
end
