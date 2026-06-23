defmodule SpellAgent.Clock do
  @moduledoc """
  The self-wake scheduler — agency rung A2 (PLAN-014).

  The body (`SpellAgent.Session.run/2`) is otherwise purely reactive: a human
  hands it a prompt, the mind runs a bounded loop, returns, and goes dark. This
  GenServer is the first organ that lets the mind *initiate*: it schedules a
  future awakening, and when the timer fires the Clock RE-ENTERS `SpellAgent.run/2`
  on the mind's behalf. A fired wake is a **synthetic caller** — the keystone the
  rest of the agency ladder composes on (A3 `black/watch` swaps the time-fuse for
  a condition-fuse; A4 `loop/continue` lets the mind author its own next prompt;
  A6 `self/spawn` aims a wake at a child session).

  ## Durability — a projection of `Hist.Store` (mirrors `ToolRegistry`)

  The Clock is a fast in-memory schedule that is ALSO a projection of the history
  store, keyed `{:clock, id} => %Clock.Wake{}`:

    * `at/1` / `every/1` PERSIST the wake to the store, THEN arm a `send_after`
      timer (durable-first: a crash between persist and arm self-heals on the next
      boot's rehydrate);
    * on `start_link/1` the Clock REHYDRATES — every persisted wake is reloaded
      and either fired now (its `fire_at` is already past) or re-armed for the
      remaining delay;
    * `cancel/1` deletes the wake from the store and disarms its timer.

  The store is the source of truth; the timer table is the cache. Which store
  backs durability is `Hist.default_store/0` (`Store.Memory` survives across runs
  within one BEAM; `Store.Khepri` survives a BEAM restart).

  ## The wake budget — the safety organ (body-enforced, the mind cannot raise it)

  Self-initiation without a governor is a fork bomb. The Clock enforces a wake
  budget: at most `max_wakes` fires per rolling `window_ms`. A fire that would
  exceed the budget is DROPPED (recorded as a dropped-wake count, surfaced via
  `pending/0`), never run — and a one-shot whose fire is dropped is still consumed
  (forgotten), so a throttled storm drains rather than queues forever. This is the
  body buying the mind more rope by making each rope safe (`docs/body-and-mind.md`,
  rung 4): the mind is free to self-schedule exactly because the body guarantees
  the schedule can never run away.

  ## Best-effort posture ("never brick the surface")

  Every store read/write is best-effort: a sick or not-yet-started store yields an
  empty schedule and silent-no-op persistence rather than a crash. The runner is
  invoked under `Task.start` so a mission raising never takes down the scheduler.
  """

  use GenServer

  require Logger

  alias SpellAgent.Clock.Wake
  alias SpellAgent.Hist
  alias SpellAgent.Hist.{Id, Store}

  @type runner :: (String.t(), keyword() -> term())

  # Default wake budget: at most 60 fires per rolling 60s window. Generous for
  # legitimate use (a goal re-checked every minute), a hard cap on a runaway
  # `clock/every {:in "1ms"}`.
  @default_max_wakes 60
  @default_window_ms 60_000

  # --- client API ------------------------------------------------------------

  @doc """
  Start the scheduler, rehydrating persisted wakes from the history store.

  Options:
    * `:store`      — store module (default `Hist.default_store/0`).
    * `:runner`     — `(prompt, opts -> term())` invoked on fire (default
      `&SpellAgent.run/2`). Injected so tests drive a fake runner with zero network.
    * `:max_wakes`  — wake-budget fire cap per window (default #{@default_max_wakes}).
    * `:window_ms`  — wake-budget rolling window in ms (default #{@default_window_ms}).
    * `:name`       — process name (default `__MODULE__`; tests pass a unique name).
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Schedule a one-shot wake. `args` (string- or atom-keyed):

    * `"in"`         — delay before firing: ms integer, or a duration string
      (`"10m"`, `"90s"`, `"2h"`, `"500ms"`). REQUIRED unless `"at"` is given.
    * `"at"`         — absolute epoch-ms to fire at (alternative to `"in"`).
    * `"prompt"`     — the mission to run when it fires. REQUIRED.
    * `"session_id"` — the session the woken mission runs in (default: a fresh id).
    * `"budget"`     — opts threaded into `SpellAgent.run/2` (`turns`, `cost_ceiling`).

  Returns `%{"ok" => true, "id" => id, "fire_at" => ms}` or `%{"err" => msg}`.
  """
  @spec at(map(), GenServer.server()) :: map()
  def at(args, server \\ __MODULE__), do: GenServer.call(server, {:schedule, args, nil})

  @doc """
  Schedule a REPEATING wake. Same args as `at/2` plus `"every"` — the repeat
  interval (ms or duration string), which also seeds the first fire delay unless
  `"in"`/`"at"` overrides it. Returns the same shape as `at/2`.
  """
  @spec every(map(), GenServer.server()) :: map()
  def every(args, server \\ __MODULE__) do
    case parse_duration(flex(args, "every")) do
      {:ok, ms} -> GenServer.call(server, {:schedule, args, ms})
      :error -> %{"err" => "clock/every requires :every as ms or a duration string (\"10m\")"}
    end
  end

  @doc "Cancel a scheduled wake by id. Idempotent. Returns `%{\"ok\" => true}`."
  @spec cancel(String.t(), GenServer.server()) :: map()
  def cancel(id, server \\ __MODULE__) when is_binary(id),
    do: GenServer.call(server, {:cancel, id})

  @doc """
  All currently-scheduled wakes (newest fire-time first) plus budget telemetry:
  `%{"wakes" => [...], "dropped" => n, "fired" => n}`.
  """
  @spec pending(GenServer.server()) :: map()
  def pending(server \\ __MODULE__), do: GenServer.call(server, :pending)

  # --- GenServer -------------------------------------------------------------

  @impl GenServer
  def init(opts) do
    store = Keyword.get(opts, :store, Hist.default_store())
    runner = Keyword.get(opts, :runner, &SpellAgent.run/2)

    state = %{
      store: store,
      runner: runner,
      max_wakes: Keyword.get(opts, :max_wakes, @default_max_wakes),
      window_ms: Keyword.get(opts, :window_ms, @default_window_ms),
      # id => timer_ref (the live arm; the store holds the durable wake)
      timers: %{},
      # recent fire timestamps (ms), for the rolling wake-budget window
      fires: [],
      dropped: 0,
      fired: 0
    }

    {:ok, rehydrate(state)}
  end

  @impl GenServer
  def handle_call({:schedule, args, repeat_ms}, _from, state) do
    with {:ok, prompt} <- require_prompt(args),
         {:ok, fire_at} <- resolve_fire_at(args, repeat_ms) do
      wake = %Wake{
        id: Id.rand("wake"),
        fire_at_ms: fire_at,
        session_id: flex(args, "session_id") || Hist.new_session_id(),
        prompt: prompt,
        budget: normalize_budget(flex(args, "budget")),
        repeat_ms: repeat_ms,
        created_ms: now()
      }

      persist(state.store, wake)
      state = arm(state, wake)
      {:reply, %{"ok" => true, "id" => wake.id, "fire_at" => fire_at}, state}
    else
      {:error, msg} -> {:reply, %{"err" => msg}, state}
    end
  end

  @impl GenServer
  def handle_call({:cancel, id}, _from, state) do
    {:reply, %{"ok" => true}, disarm(state, id)}
  end

  @impl GenServer
  def handle_call(:pending, _from, state) do
    wakes =
      state.store
      |> safe_list()
      |> Enum.sort_by(& &1.fire_at_ms, :desc)
      |> Enum.map(&Wake.render/1)

    {:reply, %{"wakes" => wakes, "dropped" => state.dropped, "fired" => state.fired}, state}
  end

  @impl GenServer
  def handle_info({:fire, id}, state) do
    {:noreply, fire(state, id)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # --- firing ----------------------------------------------------------------

  # Load the wake (store is source of truth), check the budget, run it under a
  # Task so a raising mission never kills the scheduler, then re-arm (repeat) or
  # forget (one-shot). A budget-exhausted fire is DROPPED + counted, and a dropped
  # one-shot is still consumed so a throttled storm drains.
  defp fire(state, id) do
    state = %{state | timers: Map.delete(state.timers, id)}

    case fetch(state.store, id) do
      {:ok, %Wake{} = wake} ->
        if budget_ok?(state) do
          run_wake(state, wake)
          state = %{state | fires: [now() | trim_fires(state)], fired: state.fired + 1}
          reschedule(state, wake)
        else
          Logger.warning("[clock] wake #{id} dropped: budget exhausted")
          state = %{state | dropped: state.dropped + 1}
          # A one-shot is consumed even when dropped (drain, don't queue forever).
          # A repeat must NOT busy-spin its tiny interval against a full budget —
          # it BACKS OFF to when the window will have room (the oldest fire ages
          # out), so a throttled storm settles to the budget rate instead of
          # re-firing + re-dropping every interval.
          if wake.repeat_ms, do: backoff(state, wake), else: forget(state, wake.id)
        end

      :error ->
        state
    end
  end

  defp run_wake(%{runner: runner}, %Wake{} = wake) do
    opts = [session_id: wake.session_id] ++ budget_opts(wake.budget)
    Task.start(fn -> runner.(wake.prompt, opts) end)
    :ok
  end

  # A repeat re-arms a fresh wake (new fire_at) under the SAME id and persists it;
  # a one-shot is deleted from the store and disappears from the schedule.
  defp reschedule(state, %Wake{repeat_ms: nil} = wake), do: forget(state, wake.id)

  defp reschedule(state, %Wake{repeat_ms: ms} = wake) when is_integer(ms) do
    next = %{wake | fire_at_ms: now() + ms, created_ms: now()}
    persist(state.store, next)
    arm(state, next)
  end

  defp forget(state, id) do
    safe_store(fn -> Store.delete(state.store, {:clock, id}) end)
    %{state | timers: Map.delete(state.timers, id)}
  end

  # Re-arm a throttled repeat at the next moment the budget window frees a slot —
  # i.e. when the oldest in-window fire ages past `window_ms` — never sooner than
  # the wake's own interval. This drains a storm to the budget rate rather than
  # re-dropping every interval. Falls back to the repeat interval if no fires are
  # recorded yet.
  defp backoff(state, %Wake{repeat_ms: ms} = wake) do
    slot_free_in =
      case Enum.min(trim_fires(state), fn -> nil end) do
        nil -> ms
        oldest -> max(oldest + state.window_ms - now(), ms)
      end

    next = %{wake | fire_at_ms: now() + slot_free_in, created_ms: now()}
    persist(state.store, next)
    arm(state, next)
  end

  # --- timers + rehydrate ----------------------------------------------------

  # Arm a send_after for the wake's remaining delay (clamped to 0 -> fire on the
  # next message turn). Replaces any existing timer for the id.
  defp arm(state, %Wake{} = wake) do
    state = cancel_timer(state, wake.id)
    delay = max(wake.fire_at_ms - now(), 0)
    ref = Process.send_after(self(), {:fire, wake.id}, delay)
    %{state | timers: Map.put(state.timers, wake.id, ref)}
  end

  defp disarm(state, id) do
    state = cancel_timer(state, id)
    forget(state, id)
  end

  defp cancel_timer(state, id) do
    case Map.fetch(state.timers, id) do
      {:ok, ref} ->
        Process.cancel_timer(ref)
        %{state | timers: Map.delete(state.timers, id)}

      :error ->
        state
    end
  end

  # On boot, reload every persisted wake and arm it. An overdue wake (fire_at in
  # the past — e.g. the BEAM was down past its time) arms with delay 0 so it fires
  # promptly. Best-effort: a sick store yields no wakes.
  defp rehydrate(state) do
    ensure_store_started(state.store)

    state.store
    |> safe_list()
    |> Enum.reduce(state, fn %Wake{} = wake, acc -> arm(acc, wake) end)
  end

  # --- wake budget -----------------------------------------------------------

  defp budget_ok?(state), do: length(trim_fires(state)) < state.max_wakes

  # Keep only fire timestamps inside the rolling window.
  defp trim_fires(%{fires: fires, window_ms: window}) do
    cutoff = now() - window
    Enum.filter(fires, &(&1 >= cutoff))
  end

  # --- arg parsing -----------------------------------------------------------

  defp require_prompt(args) do
    case flex(args, "prompt") do
      p when is_binary(p) and p != "" -> {:ok, p}
      _ -> {:error, "clock wake requires a non-empty :prompt"}
    end
  end

  # Resolve the absolute fire time from `:at` (epoch-ms) | `:in` (delay) | the
  # repeat interval (every seeds its own first fire).
  defp resolve_fire_at(args, repeat_ms) do
    cond do
      is_integer(flex(args, "at")) ->
        {:ok, flex(args, "at")}

      not is_nil(flex(args, "in")) ->
        case parse_duration(flex(args, "in")) do
          {:ok, ms} -> {:ok, now() + ms}
          :error -> {:error, "clock :in must be ms or a duration string (\"10m\", \"90s\")"}
        end

      is_integer(repeat_ms) ->
        {:ok, now() + repeat_ms}

      true ->
        {:error, "clock wake requires :in (delay), :at (epoch-ms), or :every (repeat)"}
    end
  end

  @doc """
  Parse a delay into milliseconds. Accepts a non-negative integer (ms) or a
  duration string with a unit suffix: `ms`, `s`, `m`, `h`, `d`. Returns
  `{:ok, ms}` | `:error`. Public for the namespace + tests.
  """
  @spec parse_duration(term()) :: {:ok, non_neg_integer()} | :error
  def parse_duration(ms) when is_integer(ms) and ms >= 0, do: {:ok, ms}

  def parse_duration(str) when is_binary(str) do
    case Regex.run(~r/^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/, str) do
      [_, n, unit] -> {:ok, String.to_integer(n) * unit_ms(unit)}
      [_, n] -> {:ok, String.to_integer(n)}
      _ -> :error
    end
  end

  def parse_duration(_), do: :error

  defp unit_ms(""), do: 1
  defp unit_ms("ms"), do: 1
  defp unit_ms("s"), do: 1_000
  defp unit_ms("m"), do: 60_000
  defp unit_ms("h"), do: 3_600_000
  defp unit_ms("d"), do: 86_400_000

  # The budget map threaded into SpellAgent.run/2. Only known keys survive, coerced
  # to the keyword opts run/2 understands; anything else is dropped (the body owns
  # the ceiling — the mind tunes UNDER it, see Session.run clamping).
  defp normalize_budget(nil), do: %{}

  defp normalize_budget(b) when is_map(b) do
    %{}
    |> put_int(b, "turns")
    |> put_num(b, "cost_ceiling")
  end

  defp normalize_budget(_), do: %{}

  defp budget_opts(budget) when is_map(budget) do
    Enum.flat_map(budget, fn
      {"turns", v} -> [max_turns: v]
      {"cost_ceiling", v} -> [cost_ceiling: v]
      _ -> []
    end)
  end

  defp put_int(acc, src, key) do
    case flex(src, key) do
      v when is_integer(v) and v > 0 -> Map.put(acc, key, v)
      _ -> acc
    end
  end

  defp put_num(acc, src, key) do
    case flex(src, key) do
      v when is_number(v) and v > 0 -> Map.put(acc, key, v)
      _ -> acc
    end
  end

  # --- store helpers (best-effort, never crash the scheduler) ----------------

  defp persist(store, %Wake{} = wake) do
    safe_store(fn -> Store.put(store, {:clock, wake.id}, wake) end)
  end

  defp fetch(store, id) do
    Store.fetch(store, {:clock, id})
  rescue
    _ -> :error
  catch
    :exit, _ -> :error
  end

  defp safe_list(store) do
    store
    |> Store.list(:clock, nil)
    |> Enum.filter(&match?(%Wake{}, &1))
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  defp ensure_store_started(store) do
    cond do
      function_exported?(store, :start, 0) -> safe_store(fn -> store.start() end)
      function_exported?(store, :start, 1) -> safe_store(fn -> store.start(nil) end)
      true -> :ok
    end
  end

  defp safe_store(fun) do
    fun.()
    :ok
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  # --- misc ------------------------------------------------------------------

  defp now, do: System.system_time(:millisecond)

  # String- or atom-key tolerant fetch (LispKeyword args arrive string-keyed;
  # Elixir callers may use atoms), mirroring Tools.flex_get / Mesh fetch_flex.
  defp flex(map, key) when is_map(map) and is_binary(key) do
    case Map.fetch(map, key) do
      {:ok, v} -> v
      :error -> Map.get(map, safe_atom(key))
    end
  end

  defp flex(_map, _key), do: nil

  defp safe_atom(k) when is_binary(k) do
    String.to_existing_atom(k)
  rescue
    ArgumentError -> nil
  end
end
