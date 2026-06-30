defmodule SpellAgent.Hist.ReducibilityTest do
  @moduledoc """
  Reducibility estimate contract (PLAN-018 W3): the `hist/reducibility` verb is a
  CHEAP analysis the rate-controller reads to decide reduce-vs-cache. It must
  estimate tok_full / tok_reduced / reducible_tokens WITHOUT performing any
  reduction and WITHOUT any inference — duplicate-detection only, errors exempt.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Namespace, Recorder}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp see(name, args, result, status_result \\ nil) do
    %{name: name, args: args, result: status_result || result}
  end

  defp reducibility(session_id) do
    verbs = Namespace.tools(Memory, session_id)
    verbs["hist/reducibility"].(%{})
  end

  test "a tape with no duplicates is irreducible (reducible_tokens == 0)" do
    a =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(tool/sh {:argv [\"ls\"]})", result: "a", tool_calls: [see("sh", %{"argv" => ["ls"]}, "out1")]},
        nil
      )

    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/sh {:argv [\"pwd\"]})", result: "b", tool_calls: [see("sh", %{"argv" => ["pwd"]}, "out2")]},
      a.id
    )

    r = reducibility("s")
    assert r["reducible_tokens"] == 0
    assert r["tok_reduced"] == r["tok_full"]
    assert r["tool_calls"] == 2
  end

  test "duplicate identical tool calls are estimated reducible (CSE), keeping one" do
    big = String.duplicate("x", 400)

    a =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(tool/sh {:argv [\"cat\" \"f\"]})", result: "a", tool_calls: [see("sh", %{"argv" => ["cat", "f"]}, big)]},
        nil
      )

    # the SAME call again -> its result payload is CSE-reducible.
    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/sh {:argv [\"cat\" \"f\"]})", result: "b", tool_calls: [see("sh", %{"argv" => ["cat", "f"]}, big)]},
      a.id
    )

    r = reducibility("s")
    # one copy's result (~100 tokens for 400 chars) is shed; the other stays.
    assert r["reducible_tokens"] > 0
    assert r["tok_reduced"] < r["tok_full"]
    assert r["tok_reduced"] >= 0
  end

  test "a failed duplicate call is NOT collapsed (errors exempt)" do
    big = String.duplicate("y", 400)

    a =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(tool/x {})", result: "a", tool_calls: [see("x", %{}, %{"err" => big})]},
        nil
      )

    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/x {})", result: "b", tool_calls: [see("x", %{}, %{"err" => big})]},
      a.id
    )

    r = reducibility("s")
    # both calls errored -> neither is collapsible, so nothing is reducible.
    assert r["reducible_tokens"] == 0
  end

  test "the estimate is deterministic for a fixed tape" do
    a =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(tool/sh {:argv [\"ls\"]})", result: "a", tool_calls: [see("sh", %{"argv" => ["ls"]}, "out")]},
        nil
      )

    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/sh {:argv [\"ls\"]})", result: "b", tool_calls: [see("sh", %{"argv" => ["ls"]}, "out")]},
      a.id
    )

    assert reducibility("s") == reducibility("s")
  end

  test "an empty session estimates zero across the board" do
    Store.put(Memory, {:session, "empty"}, %SpellAgent.Hist.Session{id: "empty", cursors: %{}})
    r = reducibility("empty")
    assert r["tok_full"] == 0
    assert r["tok_reduced"] == 0
    assert r["reducible_tokens"] == 0
    assert r["nodes"] == 0
  end
end
