defmodule SpellAgent.HistCassette do
  @moduledoc """
  Record/replay fixtures for Hist tests — the project's "cassette" mechanism.

  There is no HTTP to record here; the analogue of a VCR cassette in this domain
  is a RECORDED CONVERSATION SESSION: a deterministic list of turns captured once,
  persisted to a fixture file, and replayed into a store so a test runs against
  the same history every time without re-deriving it.

  A cassette is a plain term file (`:erlang.term_to_binary`) under
  `test/fixtures/hist/<name>.cassette`. It holds the ordered turns of a session
  (the same shape `Recorder.record_node/4` accepts). `load/2` replays the cassette
  into a store and returns the recorded nodes; `record/3` writes one.

  Two backends are supported so a cassette proves the SAME history survives both:
    * `SpellAgent.Hist.Store.Memory` — the default in-RAM store.
    * `SpellAgent.Hist.Store.Khepri` — the durable on-disk store (tagged tests).

  This keeps the tests honest: the provenance / form-tree / span assertions run
  against history that was serialized to disk and read back, not against an
  in-memory object the test just built.
  """

  alias SpellAgent.Hist.{Recorder, Store}

  @cassette_dir Path.join([__DIR__, "..", "fixtures", "hist"])

  @doc "Absolute path of a named cassette file."
  @spec path(String.t()) :: String.t()
  def path(name), do: Path.join(@cassette_dir, name <> ".cassette")

  @doc """
  Record a cassette: a session's ordered turns (each a map accepted by
  `Recorder.record_node/4`). Persists to `test/fixtures/hist/<name>.cassette`.
  Returns the cassette path.
  """
  @spec record(String.t(), String.t(), [map()]) :: String.t()
  def record(name, session_id, turns) when is_list(turns) do
    File.mkdir_p!(@cassette_dir)
    payload = %{session_id: session_id, turns: turns, version: 1}
    p = path(name)
    File.write!(p, :erlang.term_to_binary(payload))
    p
  end

  @doc """
  Replay a cassette into `store`, recording each turn as a linked node chain under
  the cassette's session id. Returns `%{session_id: String.t(), nodes: [Node.t()]}`
  (nodes in seq order). The store is NOT cleared — callers clear/scope as needed.
  """
  @spec load(String.t(), module()) :: %{session_id: String.t(), nodes: [SpellAgent.Hist.Node.t()]}
  def load(name, store) do
    %{session_id: sid, turns: turns} =
      name |> path() |> File.read!() |> :erlang.binary_to_term()

    {nodes, _parent} =
      Enum.reduce(turns, {[], nil}, fn turn, {acc, parent_id} ->
        node = Recorder.record_node(store, sid, turn, parent_id)
        {[node | acc], node.id}
      end)

    %{session_id: sid, nodes: Enum.reverse(nodes)}
  end

  @doc """
  Record-then-load in one step: persist the cassette, then replay it into `store`.
  Use in a test's setup so the fixture file exists on disk and the assertions run
  against the reloaded history. Idempotent: re-recording overwrites.
  """
  @spec ensure(String.t(), String.t(), [map()], module()) ::
          %{session_id: String.t(), nodes: [SpellAgent.Hist.Node.t()]}
  def ensure(name, session_id, turns, store) do
    Store.clear(store)
    record(name, session_id, turns)
    load(name, store)
  end
end
