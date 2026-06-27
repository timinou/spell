defmodule SpellAgent.Mesh.Join do
  @moduledoc """
  Owner-independent join registry for spawned child missions (PLAN-019 M1,
  FEAT-011).

  `tool/spawn-session` ALWAYS DETACHES (doc-14): it starts a child
  `SpellAgent.Session.run/2` under a supervised Task and returns a
  `%MissionHandle{}` immediately. `tool/await-session` later REJOINS that child
  by its session id and returns its result. The two calls may run in DIFFERENT
  BEAM processes — each agent turn runs in a fresh `Task.async` process (see
  `App`), so a child spawned in turn N is awaited from turn N+1's process. BEAM
  `Task.await/2` is owner-restricted (only the spawning process may await), so it
  CANNOT express this. This server owns the child Task's monitor instead, so
  ANY process can await by session id.

  ## Lifecycle (per child)

    * `spawn/4` starts the child fn under `SpellAgent.Mesh.TaskSupervisor` via
      `async_nolink` (so the server, not the caller, receives the result message
      and the `:DOWN`), records `child_sid => entry`, and returns `:ok`.
    * the child completes → the server stores the result (`status: :done`),
      releases the budget slot, and replies `{:ok, result}` to every waiter.
    * the child crashes → the `:DOWN` (no result first) stores
      `status: {:error, reason}`, releases the slot, and replies `{:error,
      reason}` to waiters — `await` NEVER hangs on a dead child.
    * `await/2` returns immediately if the result is already in, else parks the
      caller's `from` and is replied when the child finishes.

  ## Budget

  The caller (`Mesh.Spawn`) acquires the `ParallelBudget` slot BEFORE calling
  `spawn/4` (so capacity is enforced fail-fast at the spawn site) and hands the
  budget struct here; this server releases it on EXACTLY ONE termination path
  (result or crash, never both — the result path demonitor-flushes the `:DOWN`).
  A `nil` budget (holder was down at spawn) is a no-op release.

  ## Best-effort

  Session-global, long-lived, supervised beside the other registries. Absent
  server → `spawn/4` runs the child INLINE-detached (a bare `Task.start`, no
  join) and `await/2` returns `{:error, :no_join}` rather than crashing — boot
  never depends on it.
  """

  use GenServer

  @task_supervisor SpellAgent.Mesh.TaskSupervisor

  # ---- client ----

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Start `fun` (a 0-arity child mission) detached, tracked under `child_sid`.

  `fun` OWNS the budget-slot release (it wraps the child body in an `after` that
  releases) so the slot is freed even if THIS server restarts mid-child — this
  server never touches the budget. Returns `:ok`, or runs the child
  inline-detached when the server is down (best-effort; await then returns
  `{:error, :no_join}`).
  """
  @spec spawn(String.t(), (-> term()), keyword()) :: :ok
  def spawn(child_sid, fun, opts \\ [])
      when is_binary(child_sid) and is_function(fun, 0) do
    server = Keyword.get(opts, :server, __MODULE__)

    case Process.whereis(server) do
      nil ->
        # No join server — detach with no join handle (fun's `after` frees the slot).
        Task.start(fun)
        :ok

      _pid ->
        GenServer.call(server, {:spawn, child_sid, fun})
    end
  end

  @doc """
  Block until the child `child_sid` finishes; return `{:ok, result}` or
  `{:error, reason}`. `{:error, :unknown_session}` for an id this server never
  spawned; `{:error, :no_join}` when the server is down.
  """
  @spec await(String.t(), keyword()) :: {:ok, term()} | {:error, term()}
  def await(child_sid, opts \\ []) when is_binary(child_sid) do
    server = Keyword.get(opts, :server, __MODULE__)
    timeout = Keyword.get(opts, :timeout, :infinity)

    case Process.whereis(server) do
      nil -> {:error, :no_join}
      _pid -> GenServer.call(server, {:await, child_sid}, timeout)
    end
  catch
    :exit, _ -> {:error, :no_join}
  end

  @doc "Whether `child_sid` is currently tracked as running. For tests/inspection."
  @spec running?(String.t(), keyword()) :: boolean()
  def running?(child_sid, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)

    case Process.whereis(server) do
      nil -> false
      _pid -> GenServer.call(server, {:running?, child_sid})
    end
  catch
    :exit, _ -> false
  end

  # ---- server ----

  @impl true
  def init(_opts), do: {:ok, %{}}

  @impl true
  def handle_call({:spawn, child_sid, fun}, _from, state) do
    task = Task.Supervisor.async_nolink(@task_supervisor, fun)

    entry = %{
      ref: task.ref,
      pid: task.pid,
      status: :running,
      result: nil,
      waiters: []
    }

    {:reply, :ok, Map.put(state, child_sid, entry)}
  end

  def handle_call({:await, child_sid}, from, state) do
    case Map.get(state, child_sid) do
      nil ->
        {:reply, {:error, :unknown_session}, state}

      %{status: :done, result: result} ->
        {:reply, {:ok, result}, state}

      %{status: {:error, reason}} ->
        {:reply, {:error, reason}, state}

      %{status: :running} = entry ->
        # Park the caller; replied when the child finishes.
        {:noreply, Map.put(state, child_sid, %{entry | waiters: [from | entry.waiters]})}
    end
  end

  def handle_call({:running?, child_sid}, _from, state) do
    running? =
      case Map.get(state, child_sid) do
        %{status: :running} -> true
        _ -> false
      end

    {:reply, running?, state}
  end

  @impl true
  def handle_info({ref, result}, state) when is_reference(ref) do
    # Normal task completion. Demonitor + flush so the paired :DOWN never arrives.
    # The budget slot is released by the child task's own `after` (Mesh.Spawn), so
    # it is freed even if THIS server restarted mid-child — we only record + reply.
    Process.demonitor(ref, [:flush])

    case pop_by_ref(state, ref) do
      {child_sid, entry} ->
        reply_waiters(entry.waiters, {:ok, result})
        {:noreply, Map.put(state, child_sid, %{entry | status: :done, result: result, waiters: []})}

      nil ->
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    # A crash BEFORE a result (a normal completion demonitor-flushes the DOWN, so
    # reaching here means no result was produced). The child's `after` still ran
    # (it wraps the body), so the slot is already freed; we only record + reply.
    case pop_by_ref(state, ref) do
      {child_sid, entry} ->
        reply_waiters(entry.waiters, {:error, reason})

        {:noreply,
         Map.put(state, child_sid, %{entry | status: {:error, reason}, waiters: []})}

      nil ->
        {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---- helpers ----

  defp pop_by_ref(state, ref) do
    Enum.find_value(state, fn {sid, %{ref: r} = entry} ->
      if r == ref, do: {sid, entry}, else: nil
    end)
  end

  defp reply_waiters(waiters, reply) do
    Enum.each(waiters, fn from -> GenServer.reply(from, reply) end)
  end
end
