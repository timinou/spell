defmodule SpellAgent.ToolRegistry do
  @moduledoc """
  Runtime registry of tools the agent can call (FEAT-826, PLAN-344).

  This is the substrate for HOMOICONICITY: a tool entry of kind `:ptc` stores
  PTC-Lisp SOURCE TEXT (code-as-data) rather than a compiled closure. When the
  agent calls `(tool/name args)`, the resolver looks the name up here FIRST,
  then falls back to native tools — so a tool the agent authored at runtime is
  indistinguishable from a built-in.

  v0 storage is in-memory (an `Agent`-backed map), session-scoped. Durable
  storage (org/memory stored programs) is a follow-up.

  > NB: this is a STUB carrying the public shape only. Full behaviour (define,
  > resolve, native-vs-ptc dispatch, system-prompt rendering) lands in FEAT-826.
  """

  use Agent

  @type entry ::
          %{kind: :ptc, name: String.t(), params: [atom()], doc: String.t(), source: String.t()}
          | %{kind: :native, name: String.t(), params: [atom()], doc: String.t(), fun: (map() -> term())}

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  @doc "Insert or replace a tool entry (keyed by `:name`)."
  @spec put(entry) :: :ok
  def put(%{name: name} = entry) do
    Agent.update(__MODULE__, &Map.put(&1, name, entry))
  end

  @doc "Fetch a tool entry by name."
  @spec get(String.t()) :: {:ok, entry} | :error
  def get(name) do
    Agent.get(__MODULE__, fn map ->
      case Map.fetch(map, name) do
        {:ok, entry} -> {:ok, entry}
        :error -> :error
      end
    end)
  end

  @doc "All tool entries as a list."
  @spec all() :: [entry]
  def all do
    Agent.get(__MODULE__, &Map.values/1)
  end

  @doc "Remove a tool entry by name."
  @spec remove(String.t()) :: :ok
  def remove(name) do
    Agent.update(__MODULE__, &Map.delete(&1, name))
  end
end
