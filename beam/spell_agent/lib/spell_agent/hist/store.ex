defmodule SpellAgent.Hist.Store do
  @moduledoc """
  Persistence behaviour for the conversation-history substrate (PLAN-001).

  All `Hist` capability logic is written against THIS behaviour, never a concrete
  engine, so every capability is tested in isolation against `Hist.Store.Memory`
  (ETS, zero infra) and runs in production against `Hist.Store.Khepri` (durable,
  transactional, in-mem + on-disk).

  ## The logical key space

  The store is a typed key/value map over logical paths. Entities and their keys:

      {:session, sid}        => %Session{}
      {:node, sid, nid}      => %Node{}
      {:mark, sid, mid}      => %Mark{}
      {:snap, sid, nid}      => %Snapshot{}
      {:tool, name}          => %ToolDef{}     (cross-session)
      {:crystal, id}         => %Crystal{}     (long-term memory)
      {:cont, sid}           => %Cont{}        (L0 replay tape + def env, one per session)
      {:hash, h}             => [node-ref]     (dedup / multi-session union index)

  A node-ref is `{sid, nid}`. `list/2` enumerates a kind, optionally scoped to a
  session, which is how slices, inventories, and queries enumerate.
  """

  alias SpellAgent.Hist.{Cont, Crystal, Mark, Node, Session, Snapshot, ToolDef}

  @type key ::
          {:session, String.t()}
          | {:node, String.t(), String.t()}
          | {:mark, String.t(), String.t()}
          | {:snap, String.t(), String.t()}
          | {:tool, String.t()}
          | {:crystal, String.t()}
          | {:cont, String.t()}
          | {:hash, String.t()}
          | {:mesh, String.t(), non_neg_integer()}
          | {:mesh_seq, String.t()}
          | {:mesh_hash, String.t(), String.t()}

  @type value ::
          Session.t()
          | Node.t()
          | Mark.t()
          | Snapshot.t()
          | ToolDef.t()
          | Crystal.t()
          | Cont.t()
          | [term()]

  @type kind :: :session | :node | :mark | :snap | :tool | :crystal | :cont | :mesh | :mesh_seq | :mesh_hash

  @doc "Store a value at a logical key. Overwrites."
  @callback put(key(), value()) :: :ok

  @doc "Fetch a value. `{:ok, value}` or `:error`."
  @callback fetch(key()) :: {:ok, value()} | :error

  @doc "Delete a key. Idempotent."
  @callback delete(key()) :: :ok

  @doc """
  List all values of a kind. When `session` is a binary, scope to that session
  (ignored for session-global kinds `:tool` / `:crystal`). Order is unspecified;
  callers that need ordering sort by `seq` / `t`.
  """
  @callback list(kind(), session :: String.t() | nil) :: [value()]

  @doc "Remove everything (test/reset). Optional; defaults via reflection in impls."
  @callback clear() :: :ok

  @doc """
  Atomically increment the integer counter stored at `key` and return the NEW
  value (starting at 1 for an absent counter). Used by the mesh substrate to
  assign a per-region monotonic sequence (`{:mesh_seq, region}`) that totally
  orders a region's records without a per-session clock — the store IS the order.
  Must be atomic under concurrent callers (ETS `update_counter` / a Khepri
  transaction); a get-then-put cannot satisfy this.
  """
  @callback incr(key()) :: integer()

  # --- convenience indirection so callers say `Store.put(impl, ...)` ---

  @doc "Dispatch `put` to a store implementation module."
  @spec put(module(), key(), value()) :: :ok
  def put(impl, key, value), do: impl.put(key, value)

  @doc "Dispatch `fetch`."
  @spec fetch(module(), key()) :: {:ok, value()} | :error
  def fetch(impl, key), do: impl.fetch(key)

  @doc "Dispatch `delete`."
  @spec delete(module(), key()) :: :ok
  def delete(impl, key), do: impl.delete(key)

  @doc "Dispatch `list`."
  @spec list(module(), kind(), String.t() | nil) :: [value()]
  def list(impl, kind, session \\ nil), do: impl.list(kind, session)

  @doc "Dispatch `clear`."
  @spec clear(module()) :: :ok
  def clear(impl), do: impl.clear()

  @doc "Dispatch `incr` — atomic counter increment, returns the new value."
  @spec incr(module(), key()) :: integer()
  def incr(impl, key), do: impl.incr(key)
end
