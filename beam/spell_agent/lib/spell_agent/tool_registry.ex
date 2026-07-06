defmodule SpellAgent.ToolRegistry do
  @moduledoc """
  Runtime registry of tools the agent can call (FEAT-826, PLAN-344, PLAN-011 W3).

  This is the substrate for HOMOICONICITY: a tool entry of kind `:ptc` stores
  PTC-Lisp SOURCE TEXT (code-as-data) rather than a compiled closure. When the
  agent calls `(tool/name args)`, the resolver looks the name up here FIRST,
  then falls back to native tools — so a tool the agent authored at runtime is
  indistinguishable from a built-in.

  ## Durability (PLAN-011 W3)

  The registry is a fast IN-MEMORY cache. For tools that should outlive the
  session, it is also a PROJECTION of the history substrate:

    * a `:ptc` entry with `scope: :durable` is MIRRORED to `Hist.Store` as a
      `%Hist.ToolDef{}` on `put/1`, and DELETED from the store on `remove/1`;
    * on `start_link/1` the registry REHYDRATES — it loads every DURABLE,
      source-bearing `:tool` `ToolDef` back into the map, so a durable tool
      resolves in every future session as if it were built in.

  The store is the source of truth for durable tools; the map is the cache.

  ### Consistency

  The map update and the store mirror run together INSIDE the Agent's serialized
  callback (`Agent.get_and_update`), so concurrent `put`/`remove` for the same
  name can never leave the map and store disagreeing, and overwriting a durable
  tool with a session/native one correctly deletes the stale store record.

  ### Projection fidelity

  Rehydration reads `ToolDef.scope` (it does not assume durable) and SKIPS
  records that are not durable or lack a binary `source` — the `:tool` kind is
  shared with other writers (`Hist.Tools.promote`, `Hist.Reconstitute` stubs)
  that may store `scope: :session` or `source: nil`. A mirror PRESERVES fields
  the registry does not own (`origin`, `stats`, original `t`) by merging onto
  any existing `ToolDef`, so promotion provenance survives a re-`put`.

  ### Safety

  Every store read/write is best-effort: a sick or not-yet-started store yields
  an empty registry and silent-no-op writes rather than crashing ("never brick
  the surface"). A single corrupt store record is skipped, not fatal — one bad
  value never wipes the whole durable toolset. `:native` entries are NEVER
  persisted (an Elixir fn is not serializable) and are re-registered every boot.

  Which store backs durability is `Hist.default_store/0`: `Store.Memory`
  (survives across runs within one BEAM) by default, `Store.Khepri` (survives
  BEAM restarts) when configured. See `docs/durable-toolset.md`.
  """

  use Agent

  alias SpellAgent.Hist
  alias SpellAgent.Hist.{Store, ToolDef}

  @type scope :: :session | :durable

  # params are metadata (docs/list-tools display) kept as STRINGS to avoid an
  # atom-table DoS on user-controlled names (PLAN-025 W1 / review S1 P1). Old
  # durable tools may still carry atoms, so accept both on read.
  @type ptc_entry :: %{
          required(:kind) => :ptc,
          required(:name) => String.t(),
          required(:params) => [String.t() | atom()],
          required(:doc) => String.t(),
          required(:source) => String.t(),
          optional(:scope) => scope()
        }

  @type native_entry :: %{
          kind: :native,
          name: String.t(),
          params: [String.t() | atom()],
          doc: String.t(),
          fun: (map() -> term())
        }

  @type entry :: ptc_entry() | native_entry()

  @doc """
  Start the registry, rehydrating durable tools from the history store.

  `:store` overrides the store module (defaults to `Hist.default_store/0`).
  Rehydration failures degrade to an empty registry — boot never depends on a
  healthy store.
  """
  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(opts \\ []) do
    store = Keyword.get(opts, :store, Hist.default_store())
    Agent.start_link(fn -> %{tools: rehydrate(store), store: store} end, name: __MODULE__)
  end

  @doc """
  Insert or replace a tool entry (keyed by `:name`).

  A `:ptc` entry with `scope: :durable` is mirrored to the bound history store
  (preserving any existing provenance). Overwriting a durable tool with a
  session/native one deletes the stale store record. The map update and the
  store write run together in the Agent's serialized callback.
  """
  @spec put(entry()) :: :ok
  def put(%{name: name} = entry) do
    Agent.update(__MODULE__, fn state ->
      sync_store(state.store, name, entry)
      %{state | tools: Map.put(state.tools, name, entry)}
    end)
  end

  @doc "Fetch a tool entry by name."
  @spec get(String.t()) :: {:ok, entry()} | :error
  def get(name) do
    Agent.get(__MODULE__, fn state ->
      case Map.fetch(state.tools, name) do
        {:ok, entry} -> {:ok, entry}
        :error -> :error
      end
    end)
  end

  @doc "All tool entries as a list."
  @spec all() :: [entry()]
  def all do
    Agent.get(__MODULE__, fn state -> Map.values(state.tools) end)
  end

  @doc """
  Remove a tool entry by name (from the in-memory map AND the durable store),
  atomically within the Agent callback. Idempotent.
  """
  @spec remove(String.t()) :: :ok
  def remove(name) do
    Agent.update(__MODULE__, fn state ->
      safe_store(fn -> Store.delete(state.store, {:tool, name}) end)
      %{state | tools: Map.delete(state.tools, name)}
    end)
  end

  # --- durability: registry entry <-> ToolDef --------------------------------

  # Reconcile the store with the entry being written. Durable :ptc with a binary
  # source -> mirror (merging onto any existing ToolDef to preserve provenance).
  # Anything else (session, native, missing source) -> ensure no stale record
  # for this name lingers. Runs INSIDE the Agent callback so it is serialized
  # with the map update.
  defp sync_store(store, name, %{kind: :ptc, scope: :durable, source: source} = entry)
       when is_binary(source) and source != "" do
    safe_store(fn ->
      merged = merge_tool_def(Store.fetch(store, {:tool, name}), entry)
      Store.put(store, {:tool, name}, merged)
    end)
  end

  defp sync_store(store, name, _entry) do
    safe_store(fn -> Store.delete(store, {:tool, name}) end)
  end

  # Build the ToolDef to mirror. The registry owns source/params/doc (refreshed
  # from the entry); the store owns provenance (origin/stats/t), so when a record
  # already exists — e.g. a promotion wrote a lineage — those fields are kept.
  defp merge_tool_def({:ok, %ToolDef{} = existing}, entry) do
    %{
      existing
      | source: entry.source,
        params: Map.get(entry, :params, []),
        doc: Map.get(entry, :doc, ""),
        scope: :durable
    }
  end

  defp merge_tool_def(_missing, entry) do
    %ToolDef{
      name: entry.name,
      source: entry.source,
      params: Map.get(entry, :params, []),
      doc: Map.get(entry, :doc, ""),
      scope: :durable,
      t: System.system_time(:millisecond)
    }
  end

  # Seed the map from DURABLE, source-bearing ToolDefs in the store. The :tool
  # kind is shared with other writers, so we read each record's own scope and
  # skip non-durable / source-less / corrupt values rather than promoting or
  # crashing. Best-effort: a store-level failure yields an empty map.
  defp rehydrate(store) do
    ensure_store_started(store)

    store
    |> safe_list()
    |> durable_map()
  end

  @doc """
  Project a list of stored `:tool` values into the registry's durable-tool map.

  Public so the rehydration contract is testable directly (the registry is a
  named singleton, so a test cannot easily re-run `start_link`). Skips any value
  that is not a durable, source-bearing `ToolDef` — the same filter boot uses.
  """
  @spec durable_map([term()]) :: %{optional(String.t()) => ptc_entry()}
  def durable_map(values) do
    Enum.reduce(values, %{}, fn value, acc ->
      case durable_entry(value) do
        {:ok, entry} -> Map.put(acc, entry.name, entry)
        :skip -> acc
      end
    end)
  end

  # A store record becomes a registry entry only if it is a durable ToolDef with
  # a usable source; everything else is skipped (NOT fatal).
  defp durable_entry(%ToolDef{scope: :durable, source: source, name: name} = td)
       when is_binary(source) and is_binary(name) and source != "" do
    {:ok,
     %{
       kind: :ptc,
       name: name,
       params: td.params || [],
       doc: td.doc || "",
       source: source,
       scope: :durable
     }}
  end

  defp durable_entry(_other), do: :skip

  # Opportunistically start the store if it exposes a `start/0|1` (Khepri is
  # started on demand, not at app boot, so a configured-Khepri rehydrate would
  # otherwise see nothing). No-op for stores without it (Memory is a supervised
  # child already running). Best-effort.
  defp ensure_store_started(store) do
    cond do
      function_exported?(store, :start, 0) -> safe_store(fn -> store.start() end)
      function_exported?(store, :start, 1) -> safe_store(fn -> store.start(nil) end)
      true -> :ok
    end
  end

  defp safe_list(store) do
    Store.list(store, :tool)
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  # Run a store op, swallowing any failure so registry ops never crash on a sick
  # store. The in-memory map mutation in the caller proceeds regardless.
  defp safe_store(fun) do
    fun.()
    :ok
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end
end
