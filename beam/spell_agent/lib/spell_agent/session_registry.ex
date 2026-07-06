defmodule SpellAgent.SessionRegistry do
  @moduledoc """
  Tracks the sessions that are RUNNING right now (PLAN-010, C1).

  The Hist substrate remembers PAST sessions — a session lands in the store only
  AFTER its mission completes (`SpellAgent.Session.run/2` records on the way out).
  So "which conversations are in flight at this instant" is data the store cannot
  answer; this registry is that missing half. A session listing unions the two:
  durable past from `Hist.sessions/1`, live present from `live/0` here.

  ## What it holds

  A map `session_id => %{session_id, prompt, model, t0, pid, ref}` of the
  currently-running missions. `register/2` is called when `Session.run` starts a
  mission; `finish/1` when it ends. The registry MONITORS the registering pid, so
  a crashed or killed run is removed automatically (its `:DOWN` arrives) — there
  is never a stale "open" row left behind by a mission that died without calling
  `finish/1`.

  ## Best-effort posture

  Liveness is an ENHANCEMENT, never a dependency of answering. Every client
  function tolerates the registry being absent (not started in a headless test,
  or crashed): `register/2`/`finish/1` no-op, `live/0` returns `[]`, `live?/1`
  returns `false`. This mirrors `Hist` recording — a sick registry must never
  change a mission's outcome. The wiring in `Session.run` is itself wrapped, so
  even a raising client call cannot fail the run.

  Session-global and long-lived, supervised beside `ToolRegistry`/`OAuth`.
  """

  use GenServer

  @type meta :: %{
          optional(:prompt) => String.t() | nil,
          optional(:model) => String.t() | nil,
          optional(:t0) => integer(),
          optional(:owner) => :human | {:session, String.t()},
          optional(:parent_id) => String.t() | nil,
          optional(:intent) => String.t() | nil,
          optional(:region) => String.t() | nil
        }

  @typedoc "A live-session row, as `live/0` returns it."
  @type live_entry :: %{
          session_id: String.t(),
          prompt: String.t() | nil,
          model: String.t() | nil,
          t0: integer(),
          pid: pid(),
          owner: :human | {:session, String.t()},
          parent_id: String.t() | nil,
          intent: String.t() | nil,
          region: String.t() | nil
        }

  @typedoc "A lineage row (`lineage/0`): the queryable spawn ancestry, no `pid`."
  @type lineage_entry :: %{
          session_id: String.t(),
          owner: :human | {:session, String.t()},
          parent_id: String.t() | nil,
          intent: String.t() | nil,
          region: String.t() | nil,
          status: :running
        }

  # ---- client ----

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Mark `session_id` as RUNNING, owned by the calling process.

  `meta` carries the opening `:prompt`, the `:model`, and `:t0` (start time);
  missing fields default (`t0` to now). FEAT-044 adds lineage fields, all
  optional (a caller that doesn't pass them gets the root-session defaults):

    * `:owner`     — `:human` (default) or `{:session, parent_id}` — who spawned
      this session.
    * `:parent_id` — the spawning session's id, or `nil` for a root session.
    * `:intent`    — the prompt/goal this session was spawned toward (defaults
      to `:prompt` when absent, since for a root session they're the same).
    * `:region`    — the mesh region this session runs in, or `nil`.

  The registry monitors `self()`, so when the caller exits — normally or by
  crash — the entry is dropped without needing `finish/1`. Best-effort: a no-op
  if the registry isn't running.
  """
  @spec register(String.t(), meta()) :: :ok
  def register(session_id, meta \\ %{}) when is_binary(session_id) do
    call_if_up({:register, session_id, self(), meta})
  end

  @doc """
  Mark `session_id` as no longer running (the mission ended).

  Idempotent and best-effort: unknown id or absent registry is a no-op. The
  monitor is demonitored so a later exit of the same pid doesn't double-fire.
  """
  @spec finish(String.t()) :: :ok
  def finish(session_id) when is_binary(session_id) do
    call_if_up({:finish, session_id})
  end

  @doc """
  Re-parent a live session's OWNER in place (PLAN-027 M6, review Sβ P2) —
  changing only the `:owner`/`:parent_id` lineage fields while PRESERVING the
  existing monitored pid + ref.

  This is what `human/adopt` needs: `register/2` would re-monitor the CALLING
  process (the TUI/PTC process, not the running child), so the registry would
  stop watching the real session and a stale row would survive its exit. This
  update touches lineage only; the monitor is untouched, so liveness stays
  correct. Best-effort: unknown id / absent registry is a no-op.
  """
  @spec set_owner(String.t(), :human | {:session, String.t()}, String.t() | nil) :: :ok
  def set_owner(session_id, owner, parent_id \\ nil) when is_binary(session_id) do
    call_if_up({:set_owner, session_id, owner, parent_id})
  end

  @doc """
  The sessions running right now, newest-started first.

  Returns `[]` when the registry isn't running (headless test / not yet started),
  so callers can union it with `Hist.sessions/1` unconditionally.
  """
  @spec live() :: [live_entry()]
  def live do
    case call_if_up(:live, :__down__) do
      :__down__ -> []
      entries -> entries
    end
  end

  @doc "Whether `session_id` is running right now. `false` if the registry is down."
  @spec live?(String.t()) :: boolean()
  def live?(session_id) when is_binary(session_id) do
    case call_if_up({:live?, session_id}, :__down__) do
      :__down__ -> false
      result -> result
    end
  end

  @doc """
  The spawn-lineage of every session running right now (FEAT-044), newest first.

  Each row is `%{session_id, owner, parent_id, intent, region, status}` — the
  ancestry query a live-TUI cockpit or a `mesh/dashboard` verb would read to
  render "who spawned whom, toward what, in which region". `status` is always
  `:running` today (a `live/0` row IS a running session); a follow-up that also
  surfaces recently-finished sessions would extend this, not replace it.

  Returns `[]` when the registry isn't running — same best-effort posture as
  `live/0`.
  """
  @spec lineage() :: [lineage_entry()]
  def lineage do
    live()
    |> Enum.map(fn entry ->
      %{
        session_id: entry.session_id,
        owner: Map.get(entry, :owner, :human),
        parent_id: Map.get(entry, :parent_id),
        intent: Map.get(entry, :intent) || entry.prompt,
        region: Map.get(entry, :region),
        status: :running
      }
    end)
  end

  # Call the registry only when it is registered + alive; otherwise return the
  # `down` sentinel (default `:ok`, the right no-op for register/finish). A
  # TOCTOU exit between whereis and call degrades to the sentinel, never a crash.
  defp call_if_up(message, down \\ :ok) do
    case Process.whereis(__MODULE__) do
      nil -> down
      _pid -> GenServer.call(__MODULE__, message)
    end
  rescue
    _ -> down
  catch
    :exit, _ -> down
  end

  # ---- server ----

  @impl true
  def init(_opts), do: {:ok, %{}}

  @impl true
  def handle_call({:register, session_id, pid, meta}, _from, state) do
    # Replace any prior entry for the same id (a resumed/re-run conversation):
    # demonitor the old owner so its later exit doesn't drop the new entry.
    state = demonitor_existing(state, session_id)
    ref = Process.monitor(pid)

    # PRESERVE lineage from a prior registration (review S4 P2): the spawn gateway
    # pre-registers a child with owner/parent/intent/region BEFORE the child's own
    # Session.run re-registers with only prompt/model. Without this merge that
    # second registration would clobber the lineage back to defaults (owner :human,
    # nil parent). A meta value that is explicitly provided still wins; a MISSING
    # lineage field falls back to the prior entry's value, not the bare default.
    prior = Map.get(state, session_id, %{})

    entry = %{
      session_id: session_id,
      prompt: Map.get(meta, :prompt) || Map.get(prior, :prompt),
      model: Map.get(meta, :model) || Map.get(prior, :model),
      t0: Map.get(meta, :t0) || Map.get(prior, :t0) || System.system_time(:millisecond),
      pid: pid,
      ref: ref,
      owner: Map.get(meta, :owner) || Map.get(prior, :owner) || :human,
      parent_id: Map.get(meta, :parent_id) || Map.get(prior, :parent_id),
      intent: Map.get(meta, :intent) || Map.get(prior, :intent),
      region: Map.get(meta, :region) || Map.get(prior, :region)
    }

    {:reply, :ok, Map.put(state, session_id, entry)}
  end

  def handle_call({:finish, session_id}, _from, state) do
    {:reply, :ok, drop(state, session_id)}
  end

  def handle_call({:set_owner, session_id, owner, parent_id}, _from, state) do
    # Update ONLY the lineage fields on an existing entry — pid + ref (the
    # monitor) are preserved, so re-parenting never re-monitors the caller
    # (review Sβ P2). Unknown id is a no-op.
    case Map.get(state, session_id) do
      %{} = entry ->
        updated = %{entry | owner: owner, parent_id: parent_id}
        {:reply, :ok, Map.put(state, session_id, updated)}

      _ ->
        {:reply, :ok, state}
    end
  end

  def handle_call(:live, _from, state) do
    entries =
      state
      |> Map.values()
      |> Enum.sort_by(& &1.t0, :desc)
      |> Enum.map(&Map.drop(&1, [:ref]))

    {:reply, entries, state}
  end

  def handle_call({:live?, session_id}, _from, state) do
    {:reply, Map.has_key?(state, session_id), state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    # A monitored owner exited (crash or normal) without calling finish/1 — drop
    # its entry by matching the monitor ref, so no stale "open" row survives.
    {:noreply, drop_by_ref(state, ref)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---- state helpers ----

  defp demonitor_existing(state, session_id) do
    case Map.get(state, session_id) do
      %{ref: ref} ->
        Process.demonitor(ref, [:flush])
        state

      _ ->
        state
    end
  end

  defp drop(state, session_id) do
    case Map.pop(state, session_id) do
      {%{ref: ref}, rest} ->
        Process.demonitor(ref, [:flush])
        rest

      {nil, rest} ->
        rest
    end
  end

  defp drop_by_ref(state, ref) do
    case Enum.find(state, fn {_id, %{ref: r}} -> r == ref end) do
      {id, _entry} -> Map.delete(state, id)
      nil -> state
    end
  end
end
