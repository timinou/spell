defmodule SpellAgent.Hist.Store.Memory do
  @moduledoc """
  In-memory `Hist.Store` implementation backed by a single ETS table (PLAN-001, W0).

  Zero infrastructure: used for isolation tests and for any ephemeral session that
  does not need durability. Same logical key space and semantics as
  `Hist.Store.Khepri`, so a capability passing here passes there.

  The ETS table is `:public`/`:named_table` and owned by a tiny GenServer so it
  survives across calls within a session without a per-call owner. Keys are the
  logical tuples from `Hist.Store`; the kind tag (first tuple element) lets `list/2`
  match by prefix.
  """

  @behaviour SpellAgent.Hist.Store

  use GenServer

  @table __MODULE__

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl GenServer
  def init(_opts) do
    table = :ets.new(@table, [:set, :public, :named_table, read_concurrency: true])
    {:ok, %{table: table}}
  end

  # --- Hist.Store callbacks (operate directly on the public ETS table) ---

  @impl SpellAgent.Hist.Store
  def put(key, value) do
    :ets.insert(@table, {key, value})
    :ok
  end

  @impl SpellAgent.Hist.Store
  def fetch(key) do
    case :ets.lookup(@table, key) do
      [{^key, value}] -> {:ok, value}
      [] -> :error
    end
  end

  @impl SpellAgent.Hist.Store
  def delete(key) do
    :ets.delete(@table, key)
    :ok
  end

  @impl SpellAgent.Hist.Store
  def list(kind, session \\ nil) do
    match =
      case {kind, session} do
        {:session, nil} -> {{:session, :_}, :"$1"}
        {:session, s} -> {{:session, s}, :"$1"}
        {:node, nil} -> {{:node, :_, :_}, :"$1"}
        {:node, s} -> {{:node, s, :_}, :"$1"}
        {:mark, nil} -> {{:mark, :_, :_}, :"$1"}
        {:mark, s} -> {{:mark, s, :_}, :"$1"}
        {:snap, nil} -> {{:snap, :_, :_}, :"$1"}
        {:snap, s} -> {{:snap, s, :_}, :"$1"}
        {:tool, _} -> {{:tool, :_}, :"$1"}
        {:crystal, _} -> {{:crystal, :_}, :"$1"}
        {:cont, nil} -> {{:cont, :_}, :"$1"}
        {:cont, s} -> {{:cont, s}, :"$1"}
      end

    :ets.select(@table, [{match, [], [:"$1"]}])
  end

  @impl SpellAgent.Hist.Store
  def clear do
    :ets.delete_all_objects(@table)
    :ok
  end
end
