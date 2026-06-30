defmodule SpellAgent.Hist.ReducibilityTest do
  @moduledoc """
  Reducibility estimate contract (PLAN-018 W3, L1-corrected): the
  `hist/reducibility` verb is a CHEAP analysis the rate-controller reads to decide
  reduce-vs-cache. It estimates tok_full / tok_reduced / reducible_tokens over the
  WIRE MODEL (form_src + result per node), WITHOUT performing any reduction and
  WITHOUT inference. Errors exempt.
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

  # Seed a chain of program turns; each `{program, result}` becomes a wire node.
  defp seed(session_id, turns) do
    Enum.reduce(turns, nil, fn {program, result}, parent ->
      Recorder.record_node(
        Memory,
        session_id,
        %{program: program, result: result},
        parent && parent.id
      )
    end)
  end

  test "a tape with distinct programs is irreducible (reducible_tokens == 0)" do
    seed("s", [
      {"(tool/sh {:argv [\"ls\"]})", "out1"},
      {"(tool/sh {:argv [\"pwd\"]})", "out2"}
    ])

    r = reducibility("s")
    assert r["reducible_tokens"] == 0
    assert r["tok_reduced"] == r["tok_full"]
    assert r["nodes"] == 2
  end

  test "the same program re-run sheds the earlier result (stale-result-collapse)" do
    big = String.duplicate("x", 400)

    seed("s", [
      {"(tool/sh {:argv [\"cat\" \"f\"]})", big},
      {"(tool/sh {:argv [\"cat\" \"f\"]})", big}
    ])

    r = reducibility("s")
    # one copy's result (~100 tokens for 400 chars) sheds; the other stays.
    assert r["reducible_tokens"] > 0
    assert r["tok_reduced"] < r["tok_full"]
    assert r["tok_reduced"] >= 0
  end

  test "a FAILED turn (status :error) never sheds its result (errors exempt)" do
    big = String.duplicate("y", 400)

    # both turns FAILED (success?: false -> status :error) -> excluded from the
    # wire-ok set, so their (identical) results are never shed. This is the
    # recovery-evidence invariant: a failed turn's output stays in the tape.
    a =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(tool/x {})", result: big, success?: false},
        nil
      )

    Recorder.record_node(
      Memory,
      "s",
      %{program: "(tool/x {})", result: big, success?: false},
      a.id
    )

    r = reducibility("s")
    assert r["reducible_tokens"] == 0
  end

  test "the estimate is deterministic for a fixed tape" do
    seed("s", [
      {"(tool/sh {:argv [\"ls\"]})", "out"},
      {"(tool/sh {:argv [\"ls\"]})", "out"}
    ])

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

  test "reducible_tokens never exceeds tok_full (sound bound)" do
    big = String.duplicate("z", 800)

    seed("s", [
      {"(tool/sh {:argv [\"cat\" \"f\"]})", big},
      {"(tool/sh {:argv [\"cat\" \"f\"]})", big},
      {"(tool/sh {:argv [\"cat\" \"f\"]})", big}
    ])

    r = reducibility("s")
    assert r["reducible_tokens"] <= r["tok_full"]
    assert r["tok_reduced"] >= 0
  end
end
