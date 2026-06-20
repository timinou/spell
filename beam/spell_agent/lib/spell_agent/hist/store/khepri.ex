defmodule SpellAgent.Hist.Store.Khepri do
  @moduledoc """
  Durable `Hist.Store` implementation backed by Khepri (PLAN-001, W4).

  Khepri is a tree-structured, on-disk, transactional store (RabbitMQ's metadata
  store). On a single node its Ra/Raft backing degenerates to an ordered,
  crash-safe write-ahead log with a materialized in-memory tree view — exactly the
  "durable event log + projected tree" shape the substrate wants: writes are
  persisted and ordered, reads hit RAM.

  ## Key → path mapping

  The logical `Hist.Store` key tuples map onto Khepri tree paths under a `:hist`
  root, so a whole kind (or a session's nodes) is a `get_many/2` with a `*`
  wildcard:

      {:session, sid}   -> [:hist, :session, sid]
      {:node, sid, nid} -> [:hist, :node, sid, nid]
      {:mark, sid, mid} -> [:hist, :mark, sid, mid]
      {:snap, sid, nid} -> [:hist, :snap, sid, nid]
      {:tool, name}     -> [:hist, :tool, name]
      {:crystal, id}    -> [:hist, :crystal, id]
      {:hash, h}        -> [:hist, :hash, h]

  Path segments must be atoms or binaries; ids are binaries, the kind tags are
  atoms, so the mapping is direct. `list/2` builds the pattern with
  `:khepri_wildcard_star` for the varying segment(s).

  ## Lifecycle

  `start/1` boots a Khepri store rooted at a data dir (defaults under
  `.spell/forest`). It is NOT an OTP child of the app supervisor by default — the
  Ra system needs explicit startup — so the integration seam (`SpellAgent.Session`)
  calls `start/1` once when durable history is enabled, and the rest of `Hist`
  talks to it through this behaviour exactly like the Memory impl.
  """

  @behaviour SpellAgent.Hist.Store

  @store :spell_hist
  @root :hist

  @doc """
  Boot the durable store at `data_dir` (default `.spell/forest`). Idempotent: a
  second call with the same dir returns `:ok`. Returns `{:ok, store_id}`.
  """
  @spec start(Path.t() | nil) :: {:ok, atom()} | {:error, term()}
  def start(data_dir \\ nil) do
    dir = data_dir || Path.join([File.cwd!(), ".spell", "forest"])
    File.mkdir_p!(dir)

    case :khepri.start(String.to_charlist(dir), @store) do
      {:ok, store_id} -> {:ok, store_id}
      :ok -> {:ok, @store}
      other -> other
    end
  end

  @doc "Stop the durable store (test teardown / shutdown)."
  @spec stop() :: :ok
  def stop do
    _ = :khepri.stop(@store)
    :ok
  end

  # --- Hist.Store callbacks ---

  @impl SpellAgent.Hist.Store
  def put(key, value) do
    :ok = :khepri.put(@store, path(key), value)
    :ok
  end

  @impl SpellAgent.Hist.Store
  def fetch(key) do
    case :khepri.get(@store, path(key)) do
      {:ok, value} -> {:ok, value}
      _ -> :error
    end
  end

  @impl SpellAgent.Hist.Store
  def delete(key) do
    _ = :khepri.delete(@store, path(key))
    :ok
  end

  @impl SpellAgent.Hist.Store
  def list(kind, session \\ nil) do
    @store
    |> :khepri.get_many(list_pattern(kind, session))
    |> case do
      {:ok, map} when is_map(map) -> Map.values(map)
      _ -> []
    end
  end

  @impl SpellAgent.Hist.Store
  def clear do
    # `#if_path_matches{regex = any}` as an Erlang record tuple: matches every
    # descendant path under the root.
    _ = :khepri.delete_many(@store, [@root, {:if_path_matches, :any, :undefined}])
    :ok
  end

  # --- key → path ---

  defp path({:session, sid}), do: [@root, :session, sid]
  defp path({:node, sid, nid}), do: [@root, :node, sid, nid]
  defp path({:mark, sid, mid}), do: [@root, :mark, sid, mid]
  defp path({:snap, sid, nid}), do: [@root, :snap, sid, nid]
  defp path({:tool, name}), do: [@root, :tool, name]
  defp path({:crystal, id}), do: [@root, :crystal, id]
  defp path({:cont, sid}), do: [@root, :cont, sid]
  defp path({:hash, h}), do: [@root, :hash, h]

  # Wildcard patterns for list/2. Session-global kinds ignore the session arg.
  defp list_pattern(:session, nil), do: [@root, :session, star()]
  defp list_pattern(:session, s), do: [@root, :session, s]
  defp list_pattern(:node, nil), do: [@root, :node, star(), star()]
  defp list_pattern(:node, s), do: [@root, :node, s, star()]
  defp list_pattern(:mark, nil), do: [@root, :mark, star(), star()]
  defp list_pattern(:mark, s), do: [@root, :mark, s, star()]
  defp list_pattern(:snap, nil), do: [@root, :snap, star(), star()]
  defp list_pattern(:snap, s), do: [@root, :snap, s, star()]
  defp list_pattern(:tool, _), do: [@root, :tool, star()]
  defp list_pattern(:crystal, _), do: [@root, :crystal, star()]
  defp list_pattern(:cont, nil), do: [@root, :cont, star()]
  defp list_pattern(:cont, s), do: [@root, :cont, s]

  # `#if_name_matches{regex = any}` as an Erlang record tuple (record has two
  # fields: regex + compiled). This is the single-level `*` wildcard; the atom
  # `:khepri_wildcard_star` is NOT accepted by get_many path patterns.
  defp star, do: {:if_name_matches, :any, :undefined}
end
