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

  @whitelist ~w(model thinking system-addendum mesh.budget mesh.lease_ms mesh.default_store hist.window_soft hist.window_hard hist.spill_threshold hist.auto_reduce)

  @defaults %{
    "model" => "claude-sonnet-5",
    "thinking" => nil,
    "system-addendum" => nil,
    "mesh.budget" => 8,
    "mesh.lease_ms" => 30_000,
    "mesh.default_store" => "memory",
    # FEAT-036: the reduction rate-controller's context-window ceilings (est
    # tokens of the full refolded tape). tok_full > soft -> lossless-regime guard;
    # tok_full > hard -> lossy overflow. Generous defaults tuned for a long
    # coding session on a 200k-context model; the mind can retune them live via
    # define-config. nil on either disables that rung (unbounded).
    "hist.window_soft" => 120_000,
    "hist.window_hard" => 170_000,
    # FEAT-037: the lossy-spill threshold in estimated result tokens — a result
    # bigger than this is shed to a re-fetchable stub. Policy the mind can retune
    # live; must stay in sync with the reducibility estimate's threshold.
    "hist.spill_threshold" => 512,
    # FEAT-036: master switch for automatic mission-boundary reduction (the
    # activated compaction engine). ON by default — the rate-controller runs at
    # each mission boundary but only REDUCES under real pressure (tape past
    # window_soft, or the economics favor a keyframe); for short sessions it is a
    # no-op that caches. The decision is zero-inference and the reduce path is
    # best-effort (degrades to the unreduced tape on any error), so activation is
    # safe. Set false to fall back to pure verbatim replay; the hist/* verbs stay
    # available to the mind either way.
    "hist.auto_reduce" => true
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
