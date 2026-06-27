defmodule SpellAgent.Mesh.Consensus.Server do
  @moduledoc """
  Serializes `black/decide` so the idempotency check + fold + commit run as ONE
  critical section (PLAN-019 M2, BUG-018).

  `Mesh.Consensus.decide_inline/1` reads `existing_verdict` THEN `Store.put`s the
  verdict — a TOCTOU window. Two sessions deciding the same
  `(region, question, watermark)` concurrently could both miss the check and
  double-commit. This server runs every decide in its single mailbox, so the
  check+commit for one decide completes before the next begins — exactly-once
  single-node (the multi-node atomic path is the Ra commit, FUP-020).

  ## Why global (not per-region) serialization

  v1 serializes ALL decides through one process. Decides are infrequent (a
  reconciliation verdict, not a hot path), so a global lock is correct + simple. A
  slow PTC `:fold` would block other regions' decides for its duration; if that
  ever matters, shard by region (a per-region worker) \u2014 filed as a note on
  FUP-020. The fold runs under the sandbox's heap/timeout caps, so it cannot block
  indefinitely.

  ## Best-effort

  App-supervised, session-global. `Mesh.Consensus.decide/1` routes here when the
  server is up and falls back to the inline path when it is absent (a bare unit
  test), so boot never depends on it.
  """

  use GenServer

  alias SpellAgent.Mesh.Consensus

  @call_timeout 60_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc "Run a decide in the serialized critical section."
  @spec decide(map()) :: Consensus.outcome()
  def decide(args) when is_map(args) do
    GenServer.call(__MODULE__, {:decide, args}, @call_timeout)
  end

  @impl true
  def init(_opts), do: {:ok, %{}}

  @impl true
  def handle_call({:decide, args}, _from, state) do
    # decide_inline does the seal+fold+commit; running it here serializes it
    # against every other decide. A fold raise is already trapped inside
    # decide_inline (-> {:error, _}), so it cannot crash this server.
    {:reply, Consensus.decide_inline(args), state}
  end
end
