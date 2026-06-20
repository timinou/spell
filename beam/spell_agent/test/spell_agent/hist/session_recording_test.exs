defmodule SpellAgent.Hist.SessionRecordingTest do
  @moduledoc """
  Integration tests for the Session<->Hist seams (PLAN-003 SEAM 1 + 5): a run
  records its history, threads one session id across runs, exposes the hist/*
  verbs to the agent, and never lets a history failure change the mission outcome.

  Driven by a FAKE llm (no network). The PTC tool_call transport means a fake llm
  that just returns text fences will loop to max_turns — that is fine here: the
  CONTRACT under test is that a finished run (success OR failure) is recorded with
  its prompt, not the agent's answer. We use a tiny max_turns to keep it fast.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.{Session, Hist}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    # Memory is supervised by the app; isolate each test by clearing it.
    Store.clear(Memory)
    :ok
  end

  defp fake_llm, do: fn _req -> {:ok, "```clojure\n(return \"ok\")\n```"} end

  test "a run records its history with the user prompt (SEAM 1)" do
    Session.run("map the auth module",
      llm: fake_llm(),
      session_id: "s",
      hist: Memory,
      max_turns: 2
    )

    nodes = Store.list(Memory, :node, "s")
    assert nodes != []

    {:ok, view} = Hist.resume("s", store: Memory)
    # the user prompt is captured on the head node -> first transcript message
    assert hd(view.messages) == %{role: :user, content: "map the auth module"}
  end

  test "two runs under one session id append to ONE conversation (SEAM 1)" do
    Session.run("first mission", llm: fake_llm(), session_id: "s", hist: Memory, max_turns: 2)
    seq_after_first = Store.list(Memory, :node, "s") |> Enum.map(& &1.seq) |> Enum.max()

    Session.run("second mission", llm: fake_llm(), session_id: "s", hist: Memory, max_turns: 2)
    seqs = Store.list(Memory, :node, "s") |> Enum.map(& &1.seq)

    # seq is monotonic across runs (no collision); both prompts are in history
    assert Enum.max(seqs) > seq_after_first
    {:ok, view} = Hist.resume("s", store: Memory)
    user_msgs = for %{role: :user, content: c} <- view.messages, do: c
    assert "first mission" in user_msgs
    assert "second mission" in user_msgs
  end

  test "the agent can call hist/* verbs about its own run mid-conversation (SEAM 5)" do
    # A program that, on turn 1, queries its own (empty-so-far) cost. We assert the
    # verb is REACHABLE in the tools map by checking the merged map directly — the
    # cleanest contract for the seam without depending on llm transport behaviour.
    verbs = Hist.verbs("s", store: Memory)
    tools = Map.merge(SpellAgent.Tools.build_tools_map(), verbs)

    assert Map.has_key?(tools, "hist/cost")
    assert Map.has_key?(tools, "hist/forms")
    assert Map.has_key?(tools, "hist/messages")
    assert Map.has_key?(tools, "hist/lens")
    # and it is callable, returning data
    assert is_function(tools["hist/cost"], 1)
  end

  test "a history-store failure does not change the mission outcome (SEAM 1 best-effort)" do
    # A bogus store module that raises on every call simulates a broken/oversized
    # history backend. The run must still return normally.
    defmodule BrokenStore do
      @behaviour SpellAgent.Hist.Store
      def put(_, _), do: raise("boom")
      def fetch(_), do: raise("boom")
      def delete(_), do: raise("boom")
      def list(_, _ \\ nil), do: raise("boom")
      def clear, do: raise("boom")
    end

    # Should not raise despite BrokenStore raising inside record_history.
    result =
      Session.run("mission", llm: fake_llm(), session_id: "s", hist: BrokenStore, max_turns: 2)

    assert match?({:ok, _}, result) or match?({:error, _}, result)
  end
end
