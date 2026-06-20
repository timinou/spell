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

  @type value ::
          Session.t()
          | Node.t()
          | Mark.t()
          | Snapshot.t()
          | ToolDef.t()
          | Crystal.t()
          | Cont.t()
          | [term()]

  @type kind :: :session | :node | :mark | :snap | :tool | :crystal | :cont

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
end
