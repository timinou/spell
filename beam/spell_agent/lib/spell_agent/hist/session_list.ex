defmodule SpellAgent.Hist.SessionList do
  @moduledoc """
  The unified session listing — open AND past (PLAN-010, C3).

  A pure projection that answers the user-facing question "what sessions exist?"
  by UNIONING two sources the substrate keeps apart:

    * PAST — `Hist.sessions/1`: every conversation recorded into the store (a
      session lands there only after a mission completes).
    * OPEN — `SpellAgent.SessionRegistry.live/0`: the conversations running right
      now, which the store cannot yet know about.

  The two are merged BY SESSION ID: a session that is both recorded and currently
  re-running shows once, tagged `live?: true`. Each row is enriched with a turn
  count and token cost from the durable nodes (`Hist.Query.cost/3`), so the
  listing is informative without the caller re-deriving it.

  ## Purity / testability

  `rows/1` reads a `Hist.Store` impl and a `live` snapshot (a list of live
  entries). The live snapshot defaults to `SessionRegistry.live/0` but is
  INJECTABLE, so a test drives the merge with a fake live list and an in-memory
  store — no registry process, no real run. Same posture as the rest of `Hist`:
  pure `(store + snapshot) -> rows`.
  """

  alias SpellAgent.Hist.{Query, Session, Store}

  @typedoc """
  One row of the listing. `live?` marks a currently-running session; `recorded?`
  marks one present in the durable store. A purely-live session (running, not yet
  recorded) has `recorded?: false` and `turns: 0` until its first turn lands.
  """
  @type row :: %{
          session_id: String.t(),
          prompt: String.t() | nil,
          model: String.t() | nil,
          t0: integer(),
          turns: non_neg_integer(),
          cost: %{input: integer(), output: integer(), total: integer()},
          live?: boolean(),
          recorded?: boolean()
        }

  @doc """
  The unified session list, live sessions first, then past by start time (desc).

  Options:
    * `:store` — the `Hist.Store` impl (default `Hist.default_store/0`).
    * `:live`  — the live-session snapshot (default `SessionRegistry.live/0`);
      inject a list to test the merge without the registry running.

  Sort order: running sessions first (most-recently-started first), then recorded
  sessions by `t0` descending — so "what's happening now" is always on top and
  the rest reads newest-to-oldest.
  """
  @spec rows(keyword()) :: [row()]
  def rows(opts \\ []) do
    impl = Keyword.get(opts, :store) || SpellAgent.Hist.default_store()
    live = Keyword.get(opts, :live) || SpellAgent.SessionRegistry.live()

    recorded = Store.list(impl, :session, nil)
    live_ids = MapSet.new(live, & &1.session_id)
    recorded_ids = MapSet.new(recorded, & &1.id)

    recorded_rows =
      Enum.map(recorded, fn %Session{} = s ->
        from_session(s, impl, MapSet.member?(live_ids, s.id))
      end)

    # Live sessions with no durable record yet (running, first turn not landed):
    # surface them too, so an in-flight conversation appears immediately.
    live_only_rows =
      live
      |> Enum.reject(&MapSet.member?(recorded_ids, &1.session_id))
      |> Enum.map(&from_live(&1, impl))

    (recorded_rows ++ live_only_rows)
    |> Enum.sort_by(&sort_key/1)
  end

  @doc """
  A single session's row, or `nil` if it is neither recorded nor live.

  Convenience for a detail header that wants the same enriched shape `rows/1`
  produces for one id.
  """
  @spec row(String.t(), keyword()) :: row() | nil
  def row(session_id, opts \\ []) when is_binary(session_id) do
    opts
    |> rows()
    |> Enum.find(&(&1.session_id == session_id))
  end

  # ---- builders ----

  defp from_session(%Session{} = s, impl, live?) do
    {turns, cost} = stats(impl, s.id)

    %{
      session_id: s.id,
      prompt: s.prompt,
      model: s.model,
      t0: s.t0,
      turns: turns,
      cost: cost,
      live?: live?,
      recorded?: true
    }
  end

  defp from_live(entry, impl) do
    # A live-only session may have early nodes recorded mid-run (each turn records
    # as it lands), so still read stats — they are 0 until the first turn persists.
    {turns, cost} = stats(impl, entry.session_id)

    %{
      session_id: entry.session_id,
      prompt: entry.prompt,
      model: entry.model,
      t0: entry.t0,
      turns: turns,
      cost: cost,
      live?: true,
      recorded?: false
    }
  end

  # Turn count + token cost from the durable nodes. Defensive: a store hiccup
  # yields zeros rather than crashing the whole listing (one bad session must not
  # sink the rest).
  defp stats(impl, session_id) do
    turns = impl |> Store.list(:node, session_id) |> length()
    cost = Query.cost(impl, session_id)
    {turns, %{input: cost.input, output: cost.output, total: cost.total}}
  rescue
    _ -> {0, %{input: 0, output: 0, total: 0}}
  end

  # Live sessions sort before recorded ones; within each group, most recent first
  # (negated t0 for ascending sort_by). `{group, -t0}`: group 0 = live, 1 = past.
  defp sort_key(%{live?: true, t0: t0}), do: {0, -t0}
  defp sort_key(%{t0: t0}), do: {1, -t0}
end
