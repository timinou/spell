defmodule SpellAgent.Hist.SessionListTest do
  @moduledoc """
  The unified session listing (PLAN-010, C3): the union of recorded (past) and
  live (open) sessions, enrichment with turn count + cost, and the live-first
  ordering. Live snapshots are INJECTED so the merge is tested without the
  registry process.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Recorder, SessionList, Store}
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp seed(session_id, opts) do
    n =
      Recorder.record_node(
        Memory,
        session_id,
        %{program: {:tool_call, "find", %{}}, memory: %{}, result: "ok", tokens: opts[:tokens]},
        nil
      )

    {:ok, s} = Store.fetch(Memory, {:session, session_id})
    meta = %{s | prompt: opts[:prompt], model: opts[:model], t0: opts[:t0] || 0}
    Store.put(Memory, {:session, session_id}, meta)
    n
  end

  test "lists recorded sessions enriched with turn count + token cost" do
    seed("s1", prompt: "p1", model: "m1", t0: 10, tokens: %{input: 4, output: 6})

    [row] = SessionList.rows(store: Memory, live: [])

    assert row.session_id == "s1"
    assert row.prompt == "p1"
    assert row.model == "m1"
    assert row.turns == 1
    assert row.cost == %{input: 4, output: 6, total: 10}
    assert row.recorded?
    refute row.live?
  end

  test "a recorded session also running now is tagged live? once" do
    seed("s1", prompt: "p1", t0: 10, tokens: %{input: 1, output: 1})
    live = [%{session_id: "s1", prompt: "p1", model: nil, t0: 10, pid: self()}]

    rows = SessionList.rows(store: Memory, live: live)

    assert [%{session_id: "s1", live?: true, recorded?: true}] = rows
    assert length(rows) == 1, "a session present in both sources must appear once"
  end

  test "a live-only session (running, not yet recorded) still surfaces" do
    live = [%{session_id: "live1", prompt: "running", model: "m", t0: 99, pid: self()}]

    rows = SessionList.rows(store: Memory, live: live)

    assert [%{session_id: "live1", live?: true, recorded?: false, turns: 0}] = rows
  end

  test "live sessions sort before past, each newest-first" do
    seed("past_old", t0: 1, tokens: %{input: 0, output: 0})
    seed("past_new", t0: 5, tokens: %{input: 0, output: 0})

    live = [
      %{session_id: "live_a", prompt: nil, model: nil, t0: 100, pid: self()},
      %{session_id: "live_b", prompt: nil, model: nil, t0: 200, pid: self()}
    ]

    ids = SessionList.rows(store: Memory, live: live) |> Enum.map(& &1.session_id)

    assert ids == ["live_b", "live_a", "past_new", "past_old"]
  end

  test "row/2 returns one session's enriched row, or nil" do
    seed("s1", prompt: "p", t0: 1, tokens: %{input: 2, output: 3})

    assert %{session_id: "s1", cost: %{total: 5}} = SessionList.row("s1", store: Memory, live: [])
    assert SessionList.row("nope", store: Memory, live: []) == nil
  end
end
