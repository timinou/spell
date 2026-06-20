defmodule SpellAgent.Hist do
  @moduledoc """
  The conversation-history substrate's front door (PLAN-001).

  `Hist` turns a raw agent conversation into operable memory: it persists each
  run's PTC-Lisp `program`, the threaded `def` environment, runtime-authored
  tools, and execution spans — all code-as-data — so the agent can resume, query,
  crystallize, and compact its own past in the language it thinks in.

  This module is the *facade*: the one surface a caller (the TUI, a headless
  driver, a test) needs. It closes over a `Hist.Store` implementation so callers
  never thread `impl` by hand, and delegates to the capability modules
  (`Recorder`, `Reconstitute`, `Window`, `Crystallize`, `Namespace`, …). Reach for
  a capability module directly only when you need a knob the facade doesn't surface.

  ## A session id

  A conversation is keyed by a `session_id`. Mint one with `new_session_id/0`,
  enumerate recorded sessions with `sessions/1`, and resume the most recent with
  `latest/1`. The session record itself is created lazily on first `record/4`.

  ## The default store

  Functions default to `default_store/0` — `Store.Khepri` (durable) in normal
  operation, overridable per call (pass a `store` module) or globally via
  `config :spell_agent, SpellAgent.Hist, store: ...`. Tests and headless runs pass
  `Store.Memory` for zero-infra isolation.

  ## Lifecycle at a glance

      sid   = Hist.new_session_id()
      _     = Hist.record(sid, step, prompt: prompt, model: model)   # after each run
      view  = Hist.resume(sid)                                       # {:ok, %View{}}
      shown = Hist.window(sid, keep_recent: 8)                       # non-destructive compaction
      verbs = Hist.verbs(sid)                                        # hist/* tool map for the agent
  """

  alias SpellAgent.Hist.{Cont, Namespace, Reconstitute, Recorder, Session, Store, Window}
  alias SpellAgent.Hist.Store.Memory

  @typedoc "A store implementation module (`Store.Memory` | `Store.Khepri`)."
  @type store :: module()

  @doc """
  The default `Hist.Store` implementation.

  Resolves `config :spell_agent, SpellAgent.Hist, store: Mod`, else falls back to
  `Store.Memory` (always available, zero infra). Production wiring sets this to
  `Store.Khepri`. Every facade function takes a `store:` option to override per call.
  """
  @spec default_store() :: store()
  def default_store do
    Application.get_env(:spell_agent, __MODULE__, [])
    |> Keyword.get(:store, Memory)
  end

  @doc "Mint a fresh, collision-resistant session id."
  @spec new_session_id() :: String.t()
  def new_session_id, do: SpellAgent.Hist.Id.rand("sess")

  @doc """
  Record one finished run into a session's history.

  Pass the `PtcRunner.Step` returned by `SubAgent.run` (on success OR failure — a
  failed run is history too) plus `prompt:` (the user message that drove it) and
  `model:`. Lazily creates the `%Session{}`, threads the node DAG onto the session
  cursor, realizes handles, content-addresses, and returns the new tip node id
  (`nil` for an empty step).

  Options: `:store`, `:prompt`, `:model`, `:parent` (branch off a non-tip node).
  """
  @spec record(String.t(), PtcRunner.Step.t(), keyword()) :: String.t() | nil
  def record(session_id, %PtcRunner.Step{} = step, opts \\ []) do
    {impl, opts} = pop_store(opts)
    # Default the L0 tape/memory from the step itself, so a caller that simply
    # ran with `collect_messages: true` gets durable continuation for free; an
    # explicit `:tape`/`:memory` opt still wins (e.g. a reconstructed suffix).
    opts =
      opts
      |> Keyword.put_new(:tape, step.messages)
      |> Keyword.put_new(:memory, step.memory)

    Recorder.record_step(impl, session_id, step, opts)
  end

  @doc """
  The L0 continuation a fresh agent loop replays to CONTINUE a conversation.

  Returns `%{tape: [message], memory: map}` — the verbatim replay tape (prior
  turns with their tool calls/results intact, system message stripped) and the
  threaded `def` environment. Seed `SubAgent.run/2` with these as
  `initial_messages:` / `initial_memory:` and the model sees the real prior
  conversation, not the lossy display lens.

  An unrecorded or tape-less session yields empty `tape`/`memory` — a cold start,
  which is exactly correct for turn 1.
  """
  @spec continuation(String.t(), keyword()) :: %{tape: [Cont.message()], memory: map()}
  def continuation(session_id, opts \\ []) do
    {impl, _opts} = pop_store(opts)

    case Store.fetch(impl, {:cont, session_id}) do
      {:ok, %Cont{tape: tape, memory: memory}} -> %{tape: tape, memory: memory}
      _ -> %{tape: [], memory: %{}}
    end
  end

  @doc """
  Reconstitute a conversation at a cursor (default `:main`) into a `Hist.View`.

  A pure fold over recorded nodes — no LLM, no tool calls — yielding the folded
  `env`, the runtime-authored `tools`, the interleaved `messages` transcript, and
  the `nodes` slice. This is the resume primitive: seed a fresh agent loop from the
  `View` and the conversation continues where it left off.
  """
  @spec resume(String.t(), keyword()) ::
          {:ok, SpellAgent.Hist.View.t()} | {:error, :no_session | :no_cursor}
  def resume(session_id, opts \\ []) do
    {impl, opts} = pop_store(opts)
    Reconstitute.at(impl, session_id, Keyword.get(opts, :cursor, :main))
  end

  @doc """
  The non-destructive compaction view: the nodes that stay VISIBLE after trimming.

  Returns the `shown` slice (initial + recent, per `:keep_recent` / `:keep_initial`).
  Trimmed turns are NOT deleted — they remain in the store and are one `recall/3`
  away. This is the durable replacement for a destructive "drop old turns" trim.

  Options: `:store`, `:keep_recent`, `:keep_initial`, `:cursor`.
  """
  @spec window(String.t(), keyword()) ::
          {:ok, %{shown: [SpellAgent.Hist.Node.t()], trimmed: [SpellAgent.Hist.Node.t()]}}
          | {:error, term()}
  def window(session_id, opts \\ []) do
    {impl, opts} = pop_store(opts)
    Window.window(impl, session_id, opts)
  end

  @doc "Pull trimmed turns back into view by keyword (C6). Returns matching nodes."
  @spec recall(String.t(), String.t(), keyword()) :: [SpellAgent.Hist.Node.t()]
  def recall(session_id, query, opts \\ []) do
    {impl, opts} = pop_store(opts)
    Window.recall(impl, session_id, query, opts)
  end

  @doc """
  Distill a set of nodes into a summary node + clearing mark (C6 Phase-2).

  Lossless: the originals stay as the summary's evidence. Returns
  `{:ok, %{summary: node, mark: mark}}` or `{:error, reason}`.
  """
  @spec distill(String.t(), [String.t()], keyword()) :: {:ok, map()} | {:error, term()}
  def distill(session_id, node_ids, opts \\ []) do
    {impl, opts} = pop_store(opts)
    Window.distill(impl, session_id, node_ids, opts)
  end

  @doc """
  The `hist/*` PTC-Lisp tool map for a session, to merge into the agent's tools.

  This is how the agent interrogates and operates on its own history in-band
  (`(hist/env {})`, `(hist/forms {:tool "edit"})`, `(hist/crystallize …)`).
  """
  @spec verbs(String.t(), keyword()) :: %{optional(String.t()) => (map() -> term())}
  def verbs(session_id, opts \\ []) do
    {impl, _opts} = pop_store(opts)
    Namespace.tools(impl, session_id)
  end

  @doc "Every recorded session, newest first (by `t0`)."
  @spec sessions(keyword()) :: [Session.t()]
  def sessions(opts \\ []) do
    {impl, _opts} = pop_store(opts)

    impl
    |> Store.list(:session, nil)
    |> Enum.sort_by(& &1.t0, :desc)
  end

  @doc """
  The most-recently-started session, or `nil` if none recorded.

  The TUI calls this on mount to reopen the last conversation; `nil` means a fresh
  start (mint a `new_session_id/0`).
  """
  @spec latest(keyword()) :: Session.t() | nil
  def latest(opts \\ []) do
    case sessions(opts) do
      [newest | _] -> newest
      [] -> nil
    end
  end

  # Split the `:store` option (defaulting) from the rest, so capability calls
  # receive only their own opts.
  defp pop_store(opts) do
    {store, rest} = Keyword.pop(opts, :store)
    {store || default_store(), rest}
  end
end
