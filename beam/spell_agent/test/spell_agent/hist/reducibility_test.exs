defmodule SpellAgent.Hist.ReducibilityTest do
  @moduledoc """
  Reducibility estimate contract (PLAN-018, L2-corrected): the `hist/reducibility`
  verb estimates what the LOSSY spill tier would shed from the wire, so the
  rate-controller decides on real savings. It must AGREE with Spill.spillable?: a
  result sheds iff its node is restorable (a pure :read) AND its rendered result
  exceeds the spill threshold (~512 tokens). Non-restorable, failed, and small
  results shed nothing. Zero inference.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Namespace, Recorder}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp reducibility(session_id) do
    verbs = Namespace.tools(Memory, session_id)
    verbs["hist/reducibility"].(%{})
  end

  # A read see (cat) so the node classifies restorable.
  defp read_see, do: [%{name: "sh", args: %{"argv" => ["cat", "f"]}, result: "ok"}]

  # ~3000 chars -> ~750 tokens, over the 512 spill threshold.
  @big String.duplicate("x", 3_000)

  test "a big RESTORABLE read result is estimated sheddable" do
    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/sh {:argv [\"cat\" \"f\"]})", result: @big, tool_calls: read_see()},
      nil
    )

    r = reducibility("s")
    assert r["reducible_tokens"] > 0
    assert r["tok_reduced"] < r["tok_full"]
  end

  test "a big NON-restorable (external) result sheds nothing" do
    Recorder.record_node(
      Memory,
      "s",
      %{
        program: "(tool/sh {:argv [\"date\"]})",
        result: @big,
        tool_calls: [%{name: "sh", args: %{"argv" => ["date"]}, result: @big}]
      },
      nil
    )

    r = reducibility("s")
    assert r["reducible_tokens"] == 0
  end

  test "a SMALL restorable result sheds nothing (below threshold)" do
    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/sh {:argv [\"cat\" \"f\"]})", result: "tiny", tool_calls: read_see()},
      nil
    )

    r = reducibility("s")
    assert r["reducible_tokens"] == 0
  end

  test "a FAILED turn's big result sheds nothing (errors exempt)" do
    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/sh {:argv [\"cat\" \"f\"]})", result: @big, success?: false, tool_calls: read_see()},
      nil
    )

    r = reducibility("s")
    assert r["reducible_tokens"] == 0
  end

  test "the estimate is deterministic for a fixed tape" do
    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/sh {:argv [\"cat\" \"f\"]})", result: @big, tool_calls: read_see()},
      nil
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

  test "a string result is tokenized raw (matching Spill, not JSON-escaped)" do
    # A newline-heavy string: JSON-encoding would ~2x it via escapes and diverge
    # from Spill's byte_size. The estimate must size it as Spill does so a lossy
    # decision is one Spill actually realizes.
    big_lines = String.duplicate("line\n", 700)

    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/sh {:argv [\"cat\" \"f\"]})", result: big_lines, tool_calls: read_see()},
      nil
    )

    r = reducibility("s")
    # ~3500 bytes / 4 ~= 875 tokens of result; the estimate should treat it as
    # sheddable (over 512) just as Spill will.
    assert r["reducible_tokens"] > 0
  end

  test "reducible_tokens never exceeds tok_full (sound bound)" do
    a =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(tool/sh {:argv [\"cat\" \"f\"]})", result: @big, tool_calls: read_see()},
        nil
      )

    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/sh {:argv [\"cat\" \"g\"]})", result: @big, tool_calls: [%{name: "sh", args: %{"argv" => ["cat", "g"]}, result: @big}]},
      a.id
    )

    r = reducibility("s")
    assert r["reducible_tokens"] <= r["tok_full"]
    assert r["tok_reduced"] >= 0
  end
end
