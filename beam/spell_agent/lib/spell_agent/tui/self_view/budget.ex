defmodule SpellAgent.Tui.SelfView.Budget do
  @moduledoc """
  PLAN-016 W3 — the loop guard for the render → observe → act cycle.

  L−1 makes the interface external working memory: the agent renders a view over
  its own trace, reads the buffer back, and acts. That is a LOOP — render →
  observe → re-render — and a loop can spin (the PROJ-001 security note: "a
  render/reason loop needs an iteration budget / fixpoint detector"). This module
  is that governor.

  ## Two guards, both per-caller

  Each mission runs as a fresh Task process (`App` spawns `Task.async` per
  submit), so the CALLER PID is a clean per-mission key. The budget is charged on
  every `view/think` render and answers one of three things:

    * `{:ok, meta}` — render normally; `meta.renders` is the running count.
    * `{:fixpoint, meta}` — this render produced the SAME buffer as the previous
      one. The agent is looking at an unchanged view; re-rendering won't teach it
      anything new. The tool surfaces this so the agent stops spinning on a
      stable view (a soft signal, not a hard stop — the buffer is still returned).
    * `{:over_budget, meta}` — the caller has rendered `@max_renders` times this
      mission. A HARD, DETERMINISTIC cut: the tool returns an `%{err}` instead of
      rendering, so a runaway render loop terminates with a clear signal rather
      than burning the turn budget on self-views.

  ## Cleanup is automatic (the SessionRegistry pattern)

  The budget `Process.monitor`s each charged pid; when the mission process exits
  (normally or by crash) its `:DOWN` drops the entry. No App hook, no manual
  reset on mission end — the same self-cleaning discipline as
  `SpellAgent.SessionRegistry`. A fresh mission (new Task pid) therefore starts
  with a fresh budget.

  ## Best-effort: the guard never blocks a render by failing

  If the budget GenServer is absent (a bare unit test, a sick supervisor), every
  charge degrades to `{:ok, %{renders: 0}}` — the self-view still works, just
  unguarded. The guard is a safety rail, never a dependency of looking.
  """

  use GenServer

  # The hard per-mission render cap. Generous enough for a real render→observe→act
  # session (look, refocus, look again, a few times), tight enough that a runaway
  # loop is cut within one turn rather than exhausting the mission budget.
  @max_renders 24

  @typedoc "Per-charge accounting returned to the caller."
  @type meta :: %{renders: non_neg_integer(), max: pos_integer()}

  @type charge_result :: {:ok, meta()} | {:fixpoint, meta()} | {:over_budget, meta()}

  # ---- client ----

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Charge one render against `pid` (default: the caller), keyed by the rendered
  `buffer` for fixpoint detection.

  Returns `{:ok | :fixpoint | :over_budget, meta}`. Best-effort: if the budget
  process is not running, returns `{:ok, %{renders: 0, max: @max_renders}}` so a
  render is never blocked by an absent guard.
  """
  @spec charge(String.t(), pid()) :: charge_result()
  def charge(buffer, pid \\ self()) when is_binary(buffer) and is_pid(pid) do
    case GenServer.whereis(__MODULE__) do
      nil -> {:ok, %{renders: 0, max: @max_renders}}
      _ -> GenServer.call(__MODULE__, {:charge, pid, fingerprint(buffer)})
    end
  rescue
    _ -> {:ok, %{renders: 0, max: @max_renders}}
  catch
    :exit, _ -> {:ok, %{renders: 0, max: @max_renders}}
  end

  @doc "Forget `pid`'s accounting (mostly for tests; live cleanup is the :DOWN monitor)."
  @spec reset(pid()) :: :ok
  def reset(pid \\ self()) when is_pid(pid) do
    case GenServer.whereis(__MODULE__) do
      nil -> :ok
      _ -> GenServer.call(__MODULE__, {:reset, pid})
    end
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  @doc "The hard per-mission render cap."
  @spec max_renders() :: pos_integer()
  def max_renders, do: @max_renders

  # ---- server ----

  @impl true
  def init(_opts), do: {:ok, %{}}

  @impl true
  def handle_call({:charge, pid, fp}, _from, state) do
    entry = Map.get(state, pid)

    {result, new_entry} = account(entry, fp, pid)
    {:reply, result, Map.put(state, pid, new_entry)}
  end

  @impl true
  def handle_call({:reset, pid}, _from, state) do
    state =
      case Map.pop(state, pid) do
        {nil, state} ->
          state

        {%{ref: ref}, rest} ->
          Process.demonitor(ref, [:flush])
          rest
      end

    {:reply, :ok, state}
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    {:noreply, Map.delete(state, pid)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---- internals ----

  # Account one render for a pid. The FIRST render of a pid starts the monitor so
  # its exit cleans the entry. Over the cap -> :over_budget (and we do NOT keep
  # incrementing past it, so the count is stable). Same fingerprint as last ->
  # :fixpoint. Otherwise :ok.
  defp account(nil, fp, pid) do
    ref = Process.monitor(pid)
    {{:ok, %{renders: 1, max: @max_renders}}, %{ref: ref, renders: 1, last: fp}}
  end

  defp account(%{renders: n} = entry, _fp, _pid) when n >= @max_renders do
    {{:over_budget, %{renders: n, max: @max_renders}}, entry}
  end

  defp account(%{renders: n, last: last} = entry, fp, _pid) do
    renders = n + 1
    meta = %{renders: renders, max: @max_renders}
    entry = %{entry | renders: renders, last: fp}

    if fp == last do
      {{:fixpoint, meta}, entry}
    else
      {{:ok, meta}, entry}
    end
  end

  # A cheap, stable fingerprint of a rendered buffer for fixpoint detection. Hash
  # (not the raw buffer) keeps the budget state small regardless of buffer size.
  defp fingerprint(buffer), do: :erlang.phash2(buffer)
end
