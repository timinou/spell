defmodule SpellAgent.Tui.Cell.Registry do
  @moduledoc """
  The live registry of reactive cells (PROJ-004 W2) — the peer of
  `SpellAgent.Tui.KeymapRegistry` and `SpellAgent.ToolRegistry`.

  A cell is a DECLARED data dependency: a named, frozen read-only query plus its
  `data/*` dependency set and a debounce window. `cell/define` writes here; the
  slow-clock layer (W3) reads the cells whose deps changed, resolves them off the
  frame clock through `SpellAgent.Tui.Cell`, and merges the results into the
  `data/*` bag under each cell's name. A render hole then references that key as
  ORDINARY pure data — the "declare vs. resolve" relocation of philosophy
  Layer -4.

  ## Stored shape

      %{name => %{
        query:    <frozen quote-codec data>,   # the read-only query, deferred
        deps:     MapSet.t(),                   # data/* keys it reads (W6 dep set)
        debounce: non_neg_integer(),            # ms quiescence before re-resolve
        resolved: term() | :unresolved          # last off-frame resolve (W3 writes)
      }}

  The `resolved` slot is the SEAM between the slow clock and the frame clock. W3
  resolves a dirty cell off-frame and stores the value here via `put_resolved/2`;
  `DataBag` then merges `resolved` values into `data/*` as a PURE READ (no eval on
  the frame clock). A freshly-defined cell is `:unresolved` until the slow clock
  first runs it, so the bag merge omits it rather than surfacing a placeholder.

  `deps` is extracted ONCE at define time via `HoleDiff.dependencies/1` (the same
  machinery render holes use), so the slow clock can decide cheaply — without
  re-walking the query — whether a `data/*` change should re-resolve this cell.

  ## The cycle guard (loop detection — spec prerequisite)

  A cell writes `data/<name>`. If it also DEPENDED on `data/<name>` (directly), a
  `data/<name>` change would re-resolve the cell, which writes `data/<name>`,
  which re-resolves it… an unbounded loop on the slow clock. `define/1` REJECTS a
  cell whose deps include its own output key. (Multi-cell cycles are a W3 concern —
  the clock there has the full dep graph; this guards the one case visible at
  define time.)

  ## Storage posture

  In-memory, Agent-backed, session-scoped — same as `KeymapRegistry`/`ToolRegistry`.
  Durable persistence (cells surviving a restart) is a follow-up (FUP-009 territory).
  """

  use Agent

  alias SpellAgent.Tui.HoleDiff

  # A cell name must look like a bare `data/*` key segment: lowercase, hyphen/
  # underscore, no slash (the name becomes `data/<name>`, and bag keys never
  # contain `/` — see HoleDiff.top_key/1). Mirrors the keymap intent discipline.
  @name_pattern ~r{\A[a-z][a-z0-9_-]*\z}

  # Max cells a session may declare. Bounds memory + the slow-clock fan-out a
  # (sandboxed, untrusted) `cell/define` burst can cause. Generous for real use.
  @max_cells 128

  # Default debounce window (ms) when a cell does not specify one. The slow clock
  # coalesces re-resolves within this quiescence window so a fast-moving cursor
  # does not fire a query per keystroke (W3 uses it).
  @default_debounce_ms 80

  @typedoc "A stored cell: its frozen query, dep set, debounce window, last value."
  @type cell :: %{
          query: term(),
          deps: MapSet.t(),
          debounce: non_neg_integer(),
          resolved: term() | :unresolved
        }

  @typedoc "The registry state: name -> cell."
  @type state :: %{optional(String.t()) => cell()}

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  @doc """
  Define (or replace) a cell named `name` with frozen read-only `query`.

  `opts` may carry `:debounce` (ms, non-negative). Returns `{:ok, cell}` or
  `{:error, reason}`. Rejected when:

    * `name` is not a bare `data/*` segment (`@name_pattern`),
    * the cell count is at `@max_cells` (and `name` is new),
    * the cell would depend on its OWN output key `data/<name>` (cycle guard).

  Deps are extracted from `query` at define time via `HoleDiff.dependencies/1`.
  """
  @spec define(String.t(), term(), keyword()) :: {:ok, cell()} | {:error, atom()}
  def define(name, query, opts \\ []) when is_binary(name) do
    debounce = normalize_debounce(Keyword.get(opts, :debounce, @default_debounce_ms))

    with :ok <- validate_name(name),
         deps = HoleDiff.dependencies(query),
         :ok <- guard_cycle(name, deps),
         :ok <- guard_capacity(name) do
      # Preserve a prior resolved value across a re-define with the SAME query, so
      # re-declaring an identical cell does not blank the pane until the next
      # off-frame resolve. A changed query resets to :unresolved (the old value is
      # for a different question).
      resolved =
        case Agent.get(__MODULE__, &Map.get(&1, name)) do
          %{query: ^query, resolved: prior} -> prior
          _ -> :unresolved
        end

      cell = %{query: query, deps: deps, debounce: debounce, resolved: resolved}
      Agent.update(__MODULE__, &Map.put(&1, name, cell))
      {:ok, cell}
    end
  end

  @doc "Fetch one cell by name, or `nil`."
  @spec get(String.t()) :: cell() | nil
  def get(name) when is_binary(name), do: Agent.get(__MODULE__, &Map.get(&1, name))

  @doc "All cells as a name -> cell map."
  @spec all() :: state()
  def all, do: Agent.get(__MODULE__, & &1)

  @doc "Remove a cell by name (idempotent)."
  @spec remove(String.t()) :: :ok
  def remove(name) when is_binary(name) do
    Agent.update(__MODULE__, &Map.delete(&1, name))
  end

  @doc "Drop every cell (test/session reset)."
  @spec reset() :: :ok
  def reset, do: Agent.update(__MODULE__, fn _ -> %{} end)

  @doc """
  Store the off-frame `value` resolved for cell `name` (the W3 slow-clock write).

  Idempotent for an absent cell (a cell removed between resolve dispatch and
  completion is simply not updated). The value is whatever `Cell.resolve/3`
  returned (already sanitized at the cell boundary).
  """
  @spec put_resolved(String.t(), term()) :: :ok
  def put_resolved(name, value) when is_binary(name) do
    Agent.update(__MODULE__, fn state ->
      case Map.get(state, name) do
        nil -> state
        cell -> Map.put(state, name, %{cell | resolved: value})
      end
    end)
  end

  @doc """
  The resolved cell values as a `name => value` map, for the `DataBag` merge.

  Only cells that have been resolved at least once are included (`:unresolved`
  cells are omitted, so the bag does not surface a placeholder for a cell the slow
  clock has not run yet). This is a PURE READ — no eval — so the frame clock stays
  effect-free.
  """
  @spec resolved_values() :: %{optional(String.t()) => term()}
  def resolved_values do
    all()
    |> Enum.flat_map(fn
      {_name, %{resolved: :unresolved}} -> []
      {name, %{resolved: value}} -> [{name, value}]
    end)
    |> Map.new()
  end

  @doc "The names of cells whose dep set intersects `changed` (the W3 trigger set)."
  @spec dirty(MapSet.t()) :: [String.t()]
  def dirty(changed) do
    all()
    |> Enum.filter(fn {_name, %{deps: deps}} -> not MapSet.disjoint?(deps, changed) end)
    |> Enum.map(fn {name, _cell} -> name end)
  end

  @doc "The default debounce window (ms)."
  @spec default_debounce_ms() :: non_neg_integer()
  def default_debounce_ms, do: @default_debounce_ms

  # ---- validation ----

  defp validate_name(name) do
    if Regex.match?(@name_pattern, name), do: :ok, else: {:error, :invalid_name}
  end

  # A cell may not depend on its own output key — that is a guaranteed slow-clock
  # loop (see moduledoc). The output key is the cell's own name.
  defp guard_cycle(name, deps) do
    if MapSet.member?(deps, name), do: {:error, :self_dependency}, else: :ok
  end

  defp guard_capacity(name) do
    state = all()

    cond do
      Map.has_key?(state, name) -> :ok
      map_size(state) < @max_cells -> :ok
      true -> {:error, :too_many_cells}
    end
  end

  defp normalize_debounce(ms) when is_integer(ms) and ms >= 0, do: ms
  defp normalize_debounce(_), do: @default_debounce_ms
end
