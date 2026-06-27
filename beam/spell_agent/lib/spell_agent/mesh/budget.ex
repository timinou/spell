defmodule SpellAgent.Mesh.Budget do
  @moduledoc """
  The app-supervised holder for the mesh's shared `ParallelBudget` (PLAN-019 M0).

  A single `PtcRunner.Lisp.Eval.ParallelBudget` slot semaphore bounds how many
  spawned child sessions (FEAT-011 `spawn-session`) and watch-fire `:do` workers
  (FEAT-013) may be alive at once across the whole node. The budget is a struct
  wrapping a lock-free `:atomics` ref, so it is created ONCE here and the same
  struct is handed to every caller — each operates on the one shared counter with
  no message round-trip (see `ParallelBudget`'s "why `:atomics`" note).

  ## Posture

  Session-global + long-lived, the same best-effort posture as `Config` and
  `ToolRegistry`: a sick or absent holder NEVER crashes a mission. The hot path
  (`spawn-session`) does `fetch/0` once and calls `ParallelBudget.try_acquire/1`
  + `release/1` on the returned struct directly; the convenience wrappers
  (`try_acquire/0`, `release/0`) exist for ergonomics and tests and degrade to
  `:no_budget` when the holder is down — boot never depends on it.

  ## Capacity

  Read from the `"mesh.budget"` config cell at `start_link/1` (a positive integer;
  falls back to `@default_capacity` for an absent/invalid value so the holder
  always starts). The capacity is fixed for the holder's lifetime — a later
  `define-config` of `"mesh.budget"` does not resize a live budget (the atomics
  counter is created with a fixed ceiling). Resizing is intentionally out of
  scope for v1; restart the holder to change it.
  """

  use Agent

  alias PtcRunner.Lisp.Eval.ParallelBudget
  alias SpellAgent.Config

  @default_capacity 8

  @doc """
  Start the holder, creating the shared budget from the `"mesh.budget"` config
  cell (or `:capacity` opt, or the default). Always returns `{:ok, pid}` — a bad
  config value degrades to the default rather than failing boot.
  """
  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(opts \\ []) do
    capacity = resolve_capacity(Keyword.get(opts, :capacity))
    Agent.start_link(fn -> ParallelBudget.new(capacity) end, name: __MODULE__)
  end

  @doc """
  Fetch the shared `ParallelBudget` struct, or `:error` if the holder is down.

  The hot path fetches once and operates on the struct directly (it wraps a
  shared atomics counter), so acquire/release need no further trip through this
  Agent.
  """
  @spec fetch() :: {:ok, ParallelBudget.t()} | :error
  def fetch do
    {:ok, Agent.get(__MODULE__, & &1)}
  catch
    :exit, _ -> :error
  end

  @doc """
  Convenience: try to acquire one slot, handing back the EXACT budget the slot was
  taken from. `{:ok, budget}` | `:full` | `:no_budget` (holder absent).

  Pair every `{:ok, budget}` with `release(budget)` — releasing the same struct is
  correct even if the holder restarts in between (the orphaned counter is
  decremented, never a fresh holder's counter). The hot path (M1/M3) may instead
  `fetch/0` once and call `ParallelBudget.try_acquire/1` + `release/1` on the
  struct directly (zero extra round-trip).
  """
  @spec try_acquire() :: {:ok, ParallelBudget.t()} | :full | :no_budget
  def try_acquire do
    case fetch() do
      {:ok, budget} ->
        case ParallelBudget.try_acquire(budget) do
          :ok -> {:ok, budget}
          :full -> :full
        end

      :error ->
        :no_budget
    end
  end

  @doc """
  Release one previously-acquired slot on the budget `try_acquire/0` returned.

  Underflow-SAFE: `ParallelBudget.release/1` raises on underflow (releasing a slot
  that was never held), but a detached worker whose holder died — or a double
  release on a crash path — must NOT brick the surface, so the underflow is
  rescued to `:ok`. This is the one place the strict ParallelBudget contract is
  deliberately softened, because the mesh budget is best-effort, not a hard
  security boundary.
  """
  @spec release(ParallelBudget.t()) :: :ok
  def release(%ParallelBudget{} = budget) do
    ParallelBudget.release(budget)
    :ok
  rescue
    RuntimeError -> :ok
  end

  @doc """
  Release a slot for a budget that may be `nil` (the holder was down at acquire).

  The detached-spawn path captures whatever `try_acquire/0` returned: a budget
  struct on success, or `nil` when no slot was taken. Releasing on child exit then
  calls this uniformly — `nil` is a no-op, a struct is an underflow-safe release.
  """
  @spec release_if(ParallelBudget.t() | nil) :: :ok
  def release_if(%ParallelBudget{} = budget), do: release(budget)
  def release_if(nil), do: :ok

  @doc "Slots currently held (0 at boot). `0` when the holder is absent."
  @spec held() :: non_neg_integer()
  def held do
    case fetch() do
      {:ok, budget} -> ParallelBudget.held(budget)
      :error -> 0
    end
  end

  @doc "Slots currently free. `0` when the holder is absent."
  @spec available() :: non_neg_integer()
  def available do
    case fetch() do
      {:ok, budget} -> ParallelBudget.available(budget)
      :error -> 0
    end
  end

  @doc "The fixed capacity of the live budget. `0` when the holder is absent."
  @spec capacity() :: non_neg_integer()
  def capacity do
    case fetch() do
      {:ok, %ParallelBudget{capacity: c}} -> c
      :error -> 0
    end
  end

  # A positive integer wins; anything else (nil, non-int, <= 0) falls back to the
  # config cell, then the default — the holder must always start.
  defp resolve_capacity(c) when is_integer(c) and c > 0, do: c
  defp resolve_capacity(_), do: from_config()

  defp from_config do
    case safe_config_get("mesh.budget") do
      c when is_integer(c) and c > 0 -> c
      _ -> @default_capacity
    end
  end

  defp safe_config_get(key) do
    Config.get(key)
  catch
    :exit, _ -> nil
  end
end
