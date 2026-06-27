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

  ## Exactly-once + fuel (FEAT-013, M3)

  One Watcher per BEAM node, attached to a `:telemetry` event `Mesh.Store.put/2`
  emits. Two bounds keep a firing well-behaved:

    * **fuel** — an intention may carry `:fuel` (a max fire count). Each fire
      decrements an in-memory per-intention counter; at 0 the intention retires.
      This bounds a self-retriggering cascade (A->B->A): it burns fuel and stops.
      `:once` is the `fuel: 1` special case (retire after the first fire).
    * **claim-dedup (exactly-once across nodes, DC-6)** — before firing, the
      Watcher `black/claim`s the firing keyed by `hash(intention_seq, event_seq)`.
      Only the claim WINNER fires. On a single node (one ETS table, one Watcher)
      there is no replication window, so the claim trivially succeeds and firing is
      exactly-once by construction. On multiple Khepri nodes two per-node Watchers
      both observe the replicated post; the claim arbitration elects ONE firer
      (best-effort exactly-once — Option B of the P1.1 correction). The HARD
      multi-node guarantee (a node-plane micro-decide via `Mesh.Consensus`, Option
      A) reuses M2 and is filed as FUP-021; an irreversible `:do` must itself route
      through `black/decide` regardless.

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

      # fuel: remaining fire budget per intention seq (lazily seeded from the
      #   intention's :fuel payload, default 1 for a :once watch / unbounded-ish
      #   for an explicit-refire watch with no :fuel).
      # done: the set of (intention_seq, event_seq) firings already claimed by THIS
      #   watcher — the local half of claim-dedup, so the same post never
      #   double-fires one intention within a node even on a telemetry re-deliver.
      {:ok,
       %{store: store, clock: clock, handler_id: handler_id, fired: 0, fuel: %{}, done: MapSet.new()}}
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
          %{acc | fuel: Map.delete(acc.fuel, intention.seq)}

        fires?(acc.store, region, record, intention) ->
          maybe_fire(acc, region, record, intention)

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

  # Gate a candidate firing through (1) local dedup, (2) cross-node claim-dedup,
  # and (3) fuel, then fire + retire when fuel is spent.
  defp maybe_fire(state, region, %{seq: event_seq}, %{seq: int_seq} = intention) do
    firing_key = {int_seq, event_seq}

    cond do
      # (1) Already fired this exact (intention, event) on THIS node — a telemetry
      #     re-deliver or a duplicate observation. Never double-fire locally.
      MapSet.member?(state.done, firing_key) ->
        state

      # (3) Fuel exhausted — retire and stop (cascade bound).
      remaining_fuel(state, intention) <= 0 ->
        retire(state, region, intention)
        %{state | fuel: Map.delete(state.fuel, int_seq)}

      # (2) Claim the firing across nodes (DC-6). Only the winner fires. Single
      #     node: the claim trivially wins (no replication window).
      not claim_firing(state, region, int_seq, event_seq) ->
        # Lost the claim (another node fired) — record local done so we don't retry.
        %{state | done: MapSet.put(state.done, firing_key)}

      true ->
        fire(state, intention)
        fuel_left = remaining_fuel(state, intention) - 1
        state = %{state | fired: state.fired + 1, done: MapSet.put(state.done, firing_key)}
        state = %{state | fuel: Map.put(state.fuel, int_seq, fuel_left)}

        if fuel_left <= 0 do
          retire(state, region, intention)
          %{state | fuel: Map.delete(state.fuel, int_seq)}
        else
          state
        end
    end
  end

  # The remaining fire budget for an intention: the in-memory counter if seen, else
  # seed from the :fuel payload. :once (default true) caps at 1; an explicit
  # once:false with no :fuel gets a large default ceiling (still bounded, so a
  # runaway cascade halts) — the agent sets :fuel for a precise bound.
  @default_refire_fuel 1000
  defp remaining_fuel(state, %{seq: seq} = intention) do
    case Map.get(state.fuel, seq) do
      n when is_integer(n) -> n
      nil -> seed_fuel(intention)
    end
  end

  defp seed_fuel(intention) do
    case get_in_payload(intention, "fuel") do
      n when is_integer(n) and n > 0 -> n
      _ -> if once?(intention), do: 1, else: @default_refire_fuel
    end
  end

  # Claim the firing (intention_seq, event_seq) so exactly one node fires it (DC-6).
  # Uses the store's claim arbitration via a dedicated :claim record whose work id
  # is the firing key; the winner is argmin(seq, author). On a single node this
  # always wins. Best-effort: a claim error degrades to "fire" (better a rare
  # double-fire of an idempotent :do than a missed fire — an irreversible :do must
  # route through black/decide anyway, per the P1.1 correction).
  defp claim_firing(state, region, int_seq, event_seq) do
    work = "fire:#{int_seq}:#{event_seq}"
    author = firing_author()

    case MeshStore.put(
           state.store,
           SpellAgent.Mesh.Record.new(:claim, region, %{"work" => work}, author: author)
         ) do
      {:ok, mine} ->
        winner =
          state.store
          |> MeshStore.claims_for(region, work)
          |> Enum.min_by(fn c -> {c.seq, c.author || ""} end, fn -> nil end)

        winner == nil or (winner.author == author and winner.seq == mine.seq)

      {:error, _} ->
        true
    end
  rescue
    _ -> true
  catch
    :exit, _ -> true
  end

  # This node's firing author id: a stable per-node identity so claim arbitration
  # distinguishes nodes. node() is the BEAM node name (one Watcher per node).
  defp firing_author, do: "watcher@#{node()}"

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
