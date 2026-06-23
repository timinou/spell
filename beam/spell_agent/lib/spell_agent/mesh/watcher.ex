defmodule SpellAgent.Mesh.Watcher do
  @moduledoc """
  The single-node condition-fuse for `black/watch` — agency rung A3 (FEAT-021).

  `black/watch` registers a standing trigger as a durable `:intention` record
  (`Mesh.Namespace`). This GenServer is what makes that intention *fire*: it tails
  the node's mesh write stream and, when a posted record satisfies a registered
  intention's predicate, schedules an **immediate `SpellAgent.Clock` wake** from
  the intention's `:wake` payload. The mind wakes with a fresh turn and its full
  toolset — A3 supplies the *condition*; A2 (`Clock`) owns the *firing*.

  ## One detonator (the A2 invariant)

  The Watcher never re-enters `SpellAgent.run/2` itself. It calls `Clock.at/2` with
  `in: 0`. So there is exactly ONE path that wakes the mind, ONE wake budget, ONE
  durable wake store. A storm of matching posts cannot spawn unbounded wakes — the
  Clock budget throttles it for free. A self-retriggering watch is bounded twice:
  `:once` retires the intention after the first fire, and the budget caps the rate.

  ## Scope: SINGLE NODE (no consensus)

  One Watcher per BEAM node, attached to a `:telemetry` event `Mesh.Store.put/2`
  emits. On a single node there is no replication window, so firing is exactly-once
  by construction — no claim-dedup, no `Mesh.Consensus`. The full distributed
  engine (per-node claim-deduped exactly-once + the inline `:do` form) is FEAT-013;
  this is its reusable single-node core.

  ## Best-effort posture ("never brick the surface")

  The telemetry handler only `send`s a message to the Watcher (lightweight, runs in
  the poster's process). Predicate evaluation + firing happen in the Watcher's own
  process, wrapped so a bad predicate or a sick store is swallowed — a watch can
  never crash the poster or the scheduler. A `black/watch` with no Watcher running
  still posts its durable intention; it simply fires whenever a Watcher next runs.
  """

  use GenServer

  require Logger

  alias SpellAgent.Clock
  alias SpellAgent.Hist
  alias SpellAgent.Hist.Store
  alias SpellAgent.Mesh.Store, as: MeshStore

  @event [:spell, :mesh, :post]

  # --- client API ------------------------------------------------------------

  @doc """
  Start the Watcher, attaching to the mesh-post telemetry event.

  Options:
    * `:store` — the `Hist.Store` impl whose intentions to evaluate (default
      `Hist.default_store/0`).
    * `:clock` — the `Clock` server fires route through (default `SpellAgent.Clock`).
    * `:name`  — process name (default `__MODULE__`; tests pass a unique name).
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  The telemetry handler — runs in the POSTER's process, so it does the minimum:
  forward the posted record to the Watcher. Public because `:telemetry.attach`
  needs a remote function.
  """
  @spec handle_event([atom()], map(), map(), map()) :: :ok
  def handle_event(@event, _measurements, %{region: region, record: record}, %{pid: pid}) do
    send(pid, {:mesh_post, region, record})
    :ok
  end

  def handle_event(_event, _measurements, _metadata, _config), do: :ok

  # --- GenServer -------------------------------------------------------------

  @impl GenServer
  def init(opts) do
    if enabled?(opts) do
      store = Keyword.get(opts, :store, Hist.default_store())
      clock = Keyword.get(opts, :clock, Clock)

      # A unique handler id so multiple Watchers (e.g. in async:false tests) attach
      # without colliding, and each detaches its own handler on terminate.
      handler_id = {__MODULE__, self()}
      :telemetry.attach(handler_id, @event, &__MODULE__.handle_event/4, %{pid: self()})

      {:ok, %{store: store, clock: clock, handler_id: handler_id, fired: 0}}
    else
      # Disabled (e.g. the :test env): do not attach, do not fire. A black/watch
      # still POSTS its durable intention; it just is not detonated here. This is
      # the load-bearing safety gate — the app-supervised default Watcher must NOT
      # fire real run/2 missions off blackboard data written by the test suite
      # (which shares the default Memory store). Tests start their OWN named
      # Watcher with `enabled: true` against an injected Clock + fake runner.
      :ignore
    end
  end

  # Start unless explicitly disabled. Per-instance `:enabled` opt wins; else the
  # app config (`config :spell_agent, SpellAgent.Mesh.Watcher, enabled: false`),
  # defaulting ON. Mirrors KhepriBoot's config-gated `:ignore` posture.
  defp enabled?(opts) do
    case Keyword.fetch(opts, :enabled) do
      {:ok, v} -> v
      :error -> Application.get_env(:spell_agent, __MODULE__, [])[:enabled] != false
    end
  end

  @impl GenServer
  def terminate(_reason, %{handler_id: handler_id}) do
    :telemetry.detach(handler_id)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  @impl GenServer
  def handle_info({:mesh_post, region, record}, state) do
    {:noreply, evaluate(state, region, record)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # --- evaluation + firing ---------------------------------------------------

  # On a post P in `region`: drop expired intentions, then for each live intention
  # whose predicate the post satisfies, fire a Clock wake and retire it (`:once`).
  # Wrapped so a bad predicate / sick store never crashes the Watcher.
  defp evaluate(state, region, record) do
    intentions = MeshStore.by_kind(state.store, region, :intention)
    now = System.system_time(:millisecond)

    Enum.reduce(intentions, state, fn intention, acc ->
      cond do
        expired?(intention, now) ->
          retire(acc, region, intention)
          acc

        fires?(acc.store, region, record, intention) ->
          fire(acc, intention)
          if once?(intention), do: retire(acc, region, intention)
          %{acc | fired: acc.fired + 1}

        true ->
          acc
      end
    end)
  rescue
    e ->
      Logger.warning("[mesh.watcher] evaluate failed: #{Exception.message(e)}")
      state
  catch
    :exit, reason ->
      Logger.warning("[mesh.watcher] evaluate exit: #{inspect(reason)}")
      state
  end

  # Does the posted record satisfy the intention's :when? Reuses Mesh.Store.by_match
  # (the SINGLE source of predicate logic) so watch matching can never drift from
  # query matching. Two forms:
  #   where/kind  — fire when the JUST-POSTED record P is itself a match.
  #   count       — fire when the region holds >= N matching records (fan-in).
  defp fires?(store, region, %{seq: posted_seq}, intention) do
    when_pred = get_in_payload(intention, "when") || %{}
    match = %{"kind" => Map.get(when_pred, "kind"), "where" => Map.get(when_pred, "where")}
    matches = MeshStore.by_match(store, region, match)

    case Map.get(when_pred, "count") do
      n when is_integer(n) and n > 0 -> length(matches) >= n
      _ -> Enum.any?(matches, &(&1.seq == posted_seq))
    end
  end

  # Fire = schedule an IMMEDIATE Clock wake from the intention's :wake payload. The
  # wake carries prompt/session_id/budget; `in: 0` makes it fire now, through the
  # one scheduler (so the wake budget + durability apply). Best-effort.
  defp fire(state, intention) do
    wake = get_in_payload(intention, "wake") || %{}
    args = Map.put(wake, "in", 0)

    case Clock.at(args, state.clock) do
      %{"ok" => true} -> :ok
      other -> Logger.warning("[mesh.watcher] clock fire rejected: #{inspect(other)}")
    end

    :ok
  rescue
    e -> Logger.warning("[mesh.watcher] fire failed: #{Exception.message(e)}")
  catch
    :exit, reason -> Logger.warning("[mesh.watcher] fire exit: #{inspect(reason)}")
  end

  # Retire an intention by deleting its stored record (idempotent, best-effort). A
  # :once watch retires after firing; an expired watch retires on observation.
  defp retire(state, region, %{seq: seq}) when is_integer(seq) do
    Store.delete(state.store, {:mesh, region, seq})
    :ok
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  defp retire(_state, _region, _intention), do: :ok

  # --- predicate helpers -----------------------------------------------------

  defp expired?(intention, now) do
    case get_in_payload(intention, "ttl_ms") do
      ttl when is_integer(ttl) and ttl > 0 ->
        reg = get_in_payload(intention, "registered_at") || 0
        now > reg + ttl

      _ ->
        false
    end
  end

  # :once defaults TRUE (a watch with no explicit once retires after first fire).
  defp once?(intention), do: get_in_payload(intention, "once") != false

  defp get_in_payload(%{payload: payload}, key) when is_map(payload), do: Map.get(payload, key)
  defp get_in_payload(_intention, _key), do: nil
end
