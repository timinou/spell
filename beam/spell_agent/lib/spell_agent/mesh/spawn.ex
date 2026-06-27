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
  alias SpellAgent.Mesh.{Budget, Join, Region, Store}

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
    region = resolve_region(args, parent_sid, prompt)

    # Acquire a slot BEFORE the Task — capacity enforced fail-fast at the spawn
    # site. :no_budget (holder down) degrades to nil (best-effort, no cap).
    budget =
      case Budget.try_acquire() do
        {:ok, b} -> b
        :full -> raise "parallel_capacity_exceeded"
        :no_budget -> nil
      end

    child_sid = Hist.new_session_id()
    watermark = safe_max_seq(store, region)
    child_tools = attenuate(args, opts)

    run_opts =
      [
        session_id: child_sid,
        region: region,
        store: store,
        hist: store,
        max_turns: opts[:max_turns]
      ]
      # :all -> no :tools key (full base surface); a list -> attenuate to it.
      |> put_tools(child_tools)
      |> maybe_put(:llm, opts[:llm])
      # S-E (FEAT-018): thread a precomputed binding slice into the child's def-env
      # (cache-neutral; the child reuses it without re-deriving). Only a map crosses.
      |> maybe_put(:inherit_memory, inherit_memory(args))

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

  # ---- region resolution ----

  # No region / "auto" -> Fork A (a fresh isolated region for this spawn). An
  # explicit region id -> join it (Fork B rendezvous). A {:structured|:slug} form
  # is passed through to Region.fork_b.
  defp resolve_region(args, parent_sid, prompt) do
    case get(args, ["region"]) do
      nil -> Region.fork_a(prompt, parent_sid)
      "auto" -> Region.fork_a(prompt, parent_sid)
      "" -> Region.fork_a(prompt, parent_sid)
      id when is_binary(id) -> id
      {:structured, _} = s -> Region.fork_b(s)
      {:slug, _} = s -> Region.fork_b(s)
      _ -> Region.fork_a(prompt, parent_sid)
    end
  end

  # ---- capability attenuation (D12) ----

  # The capability subset the child may call from its base tool surface
  # (find/sh/define-*/...), CLAMPED to the parent's own ceiling (D12: capability
  # only narrows down the spawn tree). Returns `:all` or a string list that
  # Session.run applies via Map.take; the child's OWN session verbs are added
  # unconditionally there, so this governs only the inherited base tools.
  #
  # ceiling (opts[:allowed]):
  #   :all (root)  -> requested list as-is, or :all when absent.
  #   list (child) -> intersect(requested, ceiling); an ABSENT :tools INHERITS the
  #                   ceiling (never widens to root). An explicit list can only
  #                   ever SHRINK it. So a child of `["find"]` can never hand a
  #                   grandchild `"sh"`.
  defp attenuate(args, opts) do
    requested =
      case get(args, ["tools"]) do
        nil -> :inherit
        list when is_list(list) -> Enum.map(list, &to_string/1)
        _ -> :inherit
      end

    clamp(requested, opts[:allowed] || :all)
  end

  # Clamp a requested capability set to the parent's ceiling.
  defp clamp(:inherit, ceiling), do: ceiling
  defp clamp(requested, :all) when is_list(requested), do: requested

  defp clamp(requested, ceiling) when is_list(requested) and is_list(ceiling) do
    # Only names the parent itself holds survive (set intersection).
    Enum.filter(requested, &(&1 in ceiling))
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

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, key, value), do: Keyword.put(opts, key, value)

  # :all -> no :tools key (child gets the full base surface, attenuation a no-op).
  # A list -> set :tools so Session.run attenuates the child's base to it.
  defp put_tools(opts, :all), do: opts
  defp put_tools(opts, list) when is_list(list), do: Keyword.put(opts, :tools, list)

  defp get(args, [key]) when is_map(args) do
    Map.get(args, key) || Map.get(args, safe_atom(key))
  end

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end
end
