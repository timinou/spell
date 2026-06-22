defmodule SpellAgent.Tui.Cell.Clock do
  @moduledoc """
  The slow-clock decision + resolution logic for reactive cells (PROJ-004 W3) —
  the pure, synchronous core the App's effectful wiring drives.

  ## The clock that is NOT the frame clock

  A render hole resolves on the FRAME clock (60fps, pure, no tools). A reactive
  cell must NOT: its query is effectful (read-only tools) and potentially costly.
  So a cell resolves on the SLOW clock — the App's `reproject/2` chokepoint, which
  fires only on a gaze/forest/store change (a keystroke, a streamed span), not per
  frame. This module decides WHICH cells a slow-clock tick should re-resolve and
  performs ONE cell's resolution; the App owns the timers, the `Task`s, and the
  registry writes (the effects).

  ## The trigger: dependency-change detection

  `dirty/2` diffs the previous `data/*` bag against the current one (via
  `HoleDiff.changed_keys/2`, the SAME machinery render-hole caching uses) and asks
  the registry which cells depend on a changed key (`Registry.dirty/1`). Only those
  cells re-resolve — a cursor move that changes `data/ui` re-runs the cells reading
  `data/ui` and nothing else. This is the fine-grained-assigns lesson: a cell is a
  pure function of its declared deps; "live" is the runtime resolving that
  dependency when (and only when) it changes.

  ## The resolution: read-only, bounded, off the bag

  `resolve/3` resolves ONE cell's frozen query through `SpellAgent.Tui.Cell` with
  the W1 read-only tier built from the live forest + gaze. It returns the cell's
  CURRENT query alongside the value so the App can CAS the write
  (`Registry.put_resolved/3`) — a result computed for query A is discarded if the
  cell was redefined to query B meanwhile. The query env is the SAME `data/*` bag
  the cell's deps were diffed against, so a cell reads live data consistently.

  ## Purity

  Everything here is a pure function of its arguments (`dirty/2`) or a single
  bounded read-only resolve (`resolve/3`). No timers, no `Task`s, no process
  state — those live in the App, so this logic is unit-testable without a running
  UI. Total: a missing cell or a failed resolve degrades to a skip / `:error`.
  """

  alias SpellAgent.Tui.Cell
  alias SpellAgent.Tui.Cell.{Registry, Tools}
  alias SpellAgent.Tui.HoleDiff

  @typedoc "A `data/*` environment (string-keyed)."
  @type bag :: %{optional(String.t()) => term()}

  @doc """
  The names of cells that should re-resolve given the bag changed from `prev` to
  `curr`.

  A cell is dirty when EITHER:

    * its dependency set intersects the keys that changed between `prev` and
      `curr` (the steady-state trigger — a cursor move re-runs the cells reading
      `data/ui`), OR
    * it has never been resolved (`:unresolved`). A cell DECLARED mid-session must
      resolve once even though none of its deps "changed" since it started
      watching them; folding unresolved cells in makes `cell/define` take effect on
      the very next tick without a spurious dependency edit.

  When `prev` is `nil` (the first tick) every key is treated as changed, so all
  registered cells are dirty. Pure + total; the result is deduplicated.
  """
  @spec dirty(bag() | nil, bag()) :: [String.t()]
  def dirty(prev, curr) when is_map(curr) do
    changed =
      case prev do
        nil -> :all
        p when is_map(p) -> HoleDiff.changed_keys(p, curr)
      end

    dep_dirty =
      case changed do
        :all -> Map.keys(Registry.all())
        keys -> if MapSet.size(keys) == 0, do: [], else: Registry.dirty(keys)
      end

    (dep_dirty ++ unresolved())
    |> Enum.uniq()
  end

  # Cells that have never been resolved — always dirty so a mid-session cell/define
  # takes effect on the next tick.
  defp unresolved do
    Registry.all()
    |> Enum.flat_map(fn
      {name, %{resolved: :unresolved}} -> [name]
      _ -> []
    end)
  end

  @doc """
  Resolve cell `name` against `env` (the live `data/*` bag) using a read-only tier
  built from `forest` + `gaze`.

  Returns `{:ok, query, value}` where `query` is the cell's CURRENT frozen query
  (for the App's CAS write) and `value` is the sanitized resolved value, or
  `:error` (cell absent, or the resolve failed/over-budget). Total + bounded.
  """
  @spec resolve(String.t(), bag(), {map(), term()}) :: {:ok, term(), term()} | :error
  def resolve(name, env, {forest, gaze}) when is_binary(name) and is_map(env) do
    case Registry.get(name) do
      %{query: query} ->
        tier = Tools.read_only(forest, gaze)

        case Cell.resolve(query, env, tier) do
          {:ok, value} -> {:ok, query, value}
          :error -> :error
        end

      _ ->
        :error
    end
  end

  def resolve(_name, _env, _ctx), do: :error
end
