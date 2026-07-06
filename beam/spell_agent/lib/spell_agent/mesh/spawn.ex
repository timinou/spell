defmodule SpellAgent.Mesh.Spawn do
  @moduledoc """
  The reflexive seam: `tool/spawn-session` + `tool/await-session` (PLAN-019 M1,
  FEAT-011) — a running session spawning a budget-bounded child session, the
  fixed point `eval(eval)` made a first-class tool.

  ## Await-free (doc-14)

  `spawn-session` ALWAYS DETACHES and returns a `%MissionHandle{}` immediately;
  "block and use the result" is expressed by the caller awaiting the handle via
  `await-session` (the gather-of-one case), never by a flag on the spec. This
  keeps the primitive doc-14-shaped so the FEAT-018 ergonomic sugars are pure
  addition over it.

  ## The boundary contract (docs/elixir-ptc-boundary.md)

  These verbs are session-merged closures (NOT static meta-tools): they close over
  the parent's resolved `:llm`, `:store`, and `:session_id` so a child inherits
  the parent's llm callback — REQUIRED so deterministic tests can script children
  with a fake llm (zero network). The `%MissionHandle{}` crosses into the sandbox
  STRING-KEYED via `handle_to_map/1` (the materialize job: a struct is an
  Elixir-internal convenience; the value a PTC program holds is plain data).
  `await-session` accepts that map back, or its `"session"` string.

  ## Capability attenuation (D12)

  A child gets ONLY the named `:tools` subset of the parent's tool surface, PLUS
  its own mesh `black/*` verbs for the spawned region — `Map.take` + `Map.merge`,
  the inject job. A child cannot reach a tool its parent did not hand it.

  ## Budget

  The `ParallelBudget` slot is acquired BEFORE the child Task starts (so capacity
  is enforced fail-fast at the spawn site — a spawn past capacity raises
  `parallel_capacity_exceeded`, rendered as an LLM-facing error exactly like
  `define_tool`'s raises) and released on the child's exit (normal OR crash) by
  `Mesh.Join`. The cap holds across recursion depth (a child that spawns takes its
  own slot from the same global budget).
  """

  alias SpellAgent.Hist
  alias SpellAgent.Mesh.{Budget, Join, Store}

  defmodule MissionHandle do
    @moduledoc """
    A spawned child mission, as data (FEAT-011). Returned by `spawn-session`,
    consumed by `await-session`. `watermark` captures the region's store seq AT
    SPAWN (forward-compat for FEAT-017 context projection); FEAT-011 captures but
    does not use it.
    """
    @enforce_keys [:session, :region, :parent]
    defstruct [:session, :region, :parent, :watermark, status: :running]

    @type t :: %__MODULE__{
            session: String.t(),
            region: String.t(),
            parent: String.t(),
            watermark: non_neg_integer() | nil,
            status: :running | :done | {:error, term()}
          }
  end

  @doc """
  The spawn verbs for a parent `session_id`, as a tool map to merge into the
  agent's tools (the same injection seam as `Mesh.verbs/2`).

  `opts`:
    * `:llm`     — the parent's resolved llm callback, inherited by children.
    * `:store`   — the Hist store impl (default `Hist.default_store/0`).
    * `:max_turns` — the parent's turn budget, the default ceiling for children.
    * `:allowed` — the parent's OWN allowed base-tool ceiling (`:all` for the
      unrestricted root, or a list of base-tool names). A child's requested
      `:tools` is CLAMPED to this ceiling so capability only narrows down the
      spawn tree (D12) — a child cannot grant a grandchild a tool the parent
      itself was never given.

  The clamped subset is handed to the child's `Session.run` as `:tools`, applied
  against the child's own base surface there.
  """
  @spec verbs(String.t(), keyword()) :: %{optional(String.t()) => (map() -> term())}
  def verbs(session_id, opts \\ []) when is_binary(session_id) do
    %{
      "spawn-session" => fn args -> spawn_session(session_id, opts, args || %{}) end,
      "await-session" => fn args -> await_session(opts, args || %{}) end
    }
  end

  @doc """
  Inventory rows for `list-tools` (so the spawn verbs are discoverable).
  """
  @spec inventory() :: [map()]
  def inventory do
    [
      %{
        "name" => "spawn-session",
        "params" => ["prompt", "region", "tools", "budget"],
        "doc" =>
          "Spawn a budget-bounded child session toward a goal; returns a mission " <>
            "handle immediately (always detaches). region absent/:auto -> a fresh " <>
            "isolated Fork-A region; a region id -> join it (rendezvous). tools is " <>
            "the subset of the parent's tools the child may call (capability " <>
            "attenuation). e.g. (tool/spawn-session {:prompt \"audit X\" :tools [\"find\"]}).",
        "kind" => "native"
      },
      %{
        "name" => "await-session",
        "params" => ["handle", "session"],
        "doc" =>
          "Block on a child spawned by spawn-session and return its result. Takes " <>
            "the handle map spawn-session returned, or its :session id. A crashed " <>
            "child returns {:error reason}, never hangs. e.g. " <>
            "(tool/await-session {:handle h}).",
        "kind" => "native"
      }
    ]
  end

  # ---- spawn-session ----

  defp spawn_session(parent_sid, opts, args) do
    prompt = require_prompt(args)
    store = opts[:store] || Hist.default_store()

    # Acquire a slot BEFORE the Task — capacity enforced fail-fast at the spawn
    # site. :no_budget (holder down) degrades to nil (best-effort, no cap).
    budget =
      case Budget.try_acquire() do
        {:ok, b} -> b
        :full -> raise "parallel_capacity_exceeded"
        :no_budget -> nil
      end

    # FEAT-044: route through the ONE spawn gateway — it resolves the region,
    # clamps :tools (D12) + the child's requested budget (FEAT-043) to this
    # session's own ceilings, and registers lineage (owner: this session, this
    # session's id as parent). The gateway does NOT itself run/spawn a process
    # (this reflexive seam needs the detached-Task + Join posture below, which
    # the gateway is agnostic to), so this call site still owns that part.
    %{session_id: child_sid, region: region, run_opts: run_opts} =
      SpellAgent.Spawn.create(prompt,
        owner: {:session, parent_sid},
        parent_id: parent_sid,
        region: get(args, ["region"]),
        tools: requested_tools(args),
        allowed: opts[:allowed] || :all,
        requested_budget: child_budget(args),
        budget: opts[:budget],
        store: store,
        llm: opts[:llm],
        max_turns: opts[:max_turns],
        inherit_memory: inherit_memory(args)
      )

    watermark = safe_max_seq(store, region)

    # The child task itself releases the budget slot on exit (normal OR crash) via
    # its own `after` — so the slot is freed even if Mesh.Join restarts mid-child
    # (the Task runs under the independent TaskSupervisor). Join only tracks the
    # result/crash for await; it does NOT release (no double-release).
    fun = fn ->
      try do
        run_child(prompt, run_opts)
      after
        Budget.release_if(budget)
      end
    end

    # If anything between here and the child being tracked fails, release the slot
    # we already acquired so it can't leak (Finding 4). On success the child's
    # `after` owns the release.
    try do
      :ok = Join.spawn(child_sid, fun)
    rescue
      e ->
        Budget.release_if(budget)
        reraise(e, __STACKTRACE__)
    catch
      kind, reason ->
        Budget.release_if(budget)
        :erlang.raise(kind, reason, __STACKTRACE__)
    end

    handle = %MissionHandle{
      session: child_sid,
      region: region,
      parent: parent_sid,
      watermark: watermark,
      status: :running
    }

    handle_to_map(handle)
  end

  # The child is a FULL Session.run/2 — its own Hist history + SessionRegistry
  # membership come for free. Returns the child's {:ok, result} | {:error, reason}.
  defp run_child(prompt, run_opts) do
    SpellAgent.Session.run(prompt, run_opts)
  end

  # ---- await-session ----

  defp await_session(_opts, args) do
    case child_sid_from(args) do
      sid when is_binary(sid) ->
        case Join.await(sid) do
          {:ok, {:ok, result}} -> %{"ok" => true, "session" => sid, "result" => result}
          {:ok, {:error, reason}} -> %{"err" => inspect(reason), "session" => sid}
          {:ok, other} -> %{"ok" => true, "session" => sid, "result" => other}
          # inspect/1, not to_string/1 — a crash reason can be a tuple/map
          # (exception + stacktrace) that to_string would raise on.
          {:error, reason} -> %{"err" => inspect(reason), "session" => sid}
        end

      _ ->
        %{"err" => "await-session requires :handle (a spawn-session handle) or :session id"}
    end
  end

  # ---- capability request (D12 clamp now lives in the SpellAgent.Spawn gateway) ----

  # The RAW :tools request from the agent's args (unclamped) — the gateway clamps
  # it against this session's `:allowed` ceiling. `nil`/absent -> `:inherit`
  # (the gateway then hands back the ceiling as-is, never widening it).
  defp requested_tools(args) do
    case get(args, ["tools"]) do
      nil -> :inherit
      list when is_list(list) -> Enum.map(list, &to_string/1)
      _ -> :inherit
    end
  end

  # ---- handle <-> data (the materialize boundary) ----

  @doc "Project a %MissionHandle{} to a string-keyed, JSON-safe map for the sandbox."
  @spec handle_to_map(MissionHandle.t()) :: map()
  def handle_to_map(%MissionHandle{} = h) do
    %{
      "session" => h.session,
      "region" => h.region,
      "parent" => h.parent,
      "watermark" => h.watermark,
      "status" => status_to_string(h.status)
    }
  end

  defp status_to_string(:running), do: "running"
  defp status_to_string(:done), do: "done"
  defp status_to_string({:error, reason}), do: "error: " <> inspect(reason)

  # await-session takes {:handle <map>} or {:session <id>} (or a bare handle map).
  defp child_sid_from(args) do
    cond do
      is_binary(get(args, ["session"])) -> get(args, ["session"])
      is_map(get(args, ["handle"])) -> handle_session(get(args, ["handle"]))
      is_binary(get(args, ["handle"])) -> get(args, ["handle"])
      is_binary(Map.get(args, "session")) -> Map.get(args, "session")
      true -> nil
    end
  end

  defp handle_session(h) when is_map(h), do: Map.get(h, "session") || Map.get(h, :session)

  # ---- helpers ----

  defp require_prompt(args) do
    case get(args, ["prompt"]) do
      s when is_binary(s) and s != "" -> s
      other -> raise ArgumentError, "spawn-session requires a non-empty :prompt, got #{inspect(other)}"
    end
  end

  # The :inherit-memory arg (a map of named bindings to seed the child's def-env).
  # Only a map is threaded; anything else -> nil (no seed). Accepts the kebab arg
  # name a PTC program writes (:inherit-memory) and the snake variant.
  defp inherit_memory(args) do
    case get(args, ["inherit-memory"]) || get(args, ["inherit_memory"]) do
      m when is_map(m) -> m
      _ -> nil
    end
  end

  defp safe_max_seq(store, region) do
    Store.max_seq(store, region)
  rescue
    _ -> 0
  catch
    _, _ -> 0
  end

  # FEAT-043: parse the agent's REQUESTED budget ceiling from its `:budget
  # {turns, cost_ceiling}` (or `max_tokens`) arg. The gateway (SpellAgent.Spawn)
  # clamps this against the parent's enforced budget — this call site only
  # parses the raw request, it no longer clamps (single clamp site, in the
  # gateway).
  defp child_budget(args) do
    SpellAgent.Budget.from_opts(budget_arg_opts(args))
  end

  # Normalize the agent's `:budget` arg (a string/atom-keyed map) into the keyword
  # shape `Budget.from_opts/1` reads. Accepts "turns"/"max_tokens"/"cost_ceiling".
  defp budget_arg_opts(args) do
    case flex(args, "budget") do
      m when is_map(m) ->
        [
          max_turns: flex(m, "turns") || flex(m, "max_turns"),
          max_tokens: flex(m, "max_tokens") || flex(m, "cost_ceiling")
        ]

      _ ->
        []
    end
  end

  # Read a key from a map tolerating string OR atom keys (PTC args arrive either).
  defp flex(m, key) when is_map(m) do
    Map.get(m, key) || Map.get(m, String.to_existing_atom(key))
  rescue
    ArgumentError -> Map.get(m, key)
  end

  defp flex(_m, _key), do: nil

  defp get(args, [key]) when is_map(args) do
    Map.get(args, key) || Map.get(args, safe_atom(key))
  end

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end
end
