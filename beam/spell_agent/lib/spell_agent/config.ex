defmodule SpellAgent.Config do
  @moduledoc """
  Live, runtime-mutable configuration cell (FEAT-826, PLAN-344).

  The homoiconic config surface: `define-config` writes here at runtime, and the
  session loop reads from here when building each turn. v0 whitelists a small set
  of keys with materially different behaviour; unknown keys are rejected so a
  typo can't silently no-op.

  Keys:
    * `"model"`            — model id passed to the Anthropic adapter.
    * `"thinking"`         — thinking level hint (passed through to SubAgent).
    * `"system-addendum"`  — extra text appended to the system prompt.
    * `"mesh.budget"`       — max parallel child sessions + watch-fire workers
      alive at once (PLAN-019 M0; read once by `Mesh.Budget` at boot).
    * `"mesh.lease_ms"`     — default claim-lease duration for `black/claim`.
    * `"mesh.default_store"` — mesh store backend hint (`"memory"` | `"khepri"`).
  """

  use Agent

  @whitelist ~w(model thinking system-addendum mesh.budget mesh.lease_ms mesh.default_store)

  @defaults %{
    "model" => "claude-sonnet-4-5-20250929",
    "thinking" => nil,
    "system-addendum" => nil,
    "mesh.budget" => 8,
    "mesh.lease_ms" => 30_000,
    "mesh.default_store" => "memory"
  }

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> @defaults end, name: __MODULE__)
  end

  @doc "Get a config value (nil if unset)."
  @spec get(String.t()) :: term()
  def get(key), do: Agent.get(__MODULE__, &Map.get(&1, key))

  @doc "All config as a map."
  @spec all() :: map()
  def all, do: Agent.get(__MODULE__, & &1)

  @doc """
  Set a whitelisted config key. `{:error, reason}` for an unknown key so the
  caller (define-config) can surface a clear message.
  """
  @spec put(String.t(), term()) :: :ok | {:error, String.t()}
  def put(key, value) when key in @whitelist do
    Agent.update(__MODULE__, &Map.put(&1, key, value))
    :ok
  end

  def put(key, _value) do
    {:error, "unknown config key #{inspect(key)}; allowed: #{Enum.join(@whitelist, ", ")}"}
  end
end
