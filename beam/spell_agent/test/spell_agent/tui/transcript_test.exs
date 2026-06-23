defmodule SpellAgent.Tui.TranscriptTest do
  @moduledoc """
  The homoiconic transcript renderer (PLAN-001): a session's recorded nodes fold
  to a full Lisp transcript — the agent's actual PTC-Lisp programs (form_src,
  comments and all) plus each tool call's realized result — with no lossy
  truncation. This is the contract the at-exit trace dump ships.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Recorder, Session, Store}
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Tui.Transcript

  setup do
    Store.clear(Memory)
    :ok
  end

  # Record a node AND advance the :main cursor, since `record_node` (unlike
  # `record_step`, which real Session.run uses) does not move the cursor — and
  # Transcript reads via Hist.resume(:main).
  defp seed(sid, attrs, parent \\ nil) do
    node = Recorder.record_node(Memory, sid, attrs, parent)
    set_main(sid, node.id)
    node
  end

  defp set_main(sid, node_id) do
    {:ok, s} = Store.fetch(Memory, {:session, sid})
    Store.put(Memory, {:session, sid}, %Session{s | cursors: Map.put(s.cursors, :main, node_id)})
  end

  test "renders the full program (with comments), tool results, and turn value" do
    seed("s", %{
      # a binary program keeps form_src verbatim (comments survive)
      program: ";; check what sessions exist\n(tool/hist/sessions {})",
      memory: %{},
      prompt: "hey show the layout",
      result: %{sessions: ["sess-aaa", "sess-bbb"]},
      # tool_calls populate node.sees (the realized effects, with results)
      tool_calls: [
        %{name: "tool/hist/sessions", args: %{}, result: %{sessions: ["sess-aaa", "sess-bbb"]}}
      ],
      tokens: %{input: 100, output: 6}
    })

    text = Transcript.text(Memory, "s")

    # header carries the session + turn count + token total (tok line sits
    # inside the parens: "(1 turns  0.1k in / 0.0k out)")
    assert text =~ ~r/;;; s  \(1 turns +0\.1k in/
    assert text =~ "0.0k out"

    # the turn header
    assert text =~ ";;; turn 1 (#1) · ok"

    # the user prompt survives in full
    assert text =~ ";; user"
    assert text =~ "hey show the layout"

    # the agent's PROGRAM survives in full — comments AND the tool call
    assert text =~ ";; check what sessions exist"
    assert text =~ "(tool/hist/sessions {})"

    # the realized tool result is rendered beside its call
    assert text =~ "tool/hist/sessions"
    assert text =~ "sess-aaa"
    assert text =~ "sess-bbb"

    # the turn's final value
    assert text =~ ";; =>"
  end

  test "returns nil for a session with no nodes (caller falls back to the trace)" do
    assert Transcript.text(Memory, "nope") == nil
  end

  test "caps a pathological result so one blob cannot drown the transcript" do
    huge = String.duplicate("x", 20_000)

    seed("big", %{
      program: "(tool/read {:path \"x\"})",
      memory: %{},
      result: huge,
      tool_calls: [%{name: "tool/read", args: %{}, result: huge}]
    })

    text = Transcript.text(Memory, "big", cap: 1_000)

    # the cap fires and reports itself; the full blob did NOT survive
    assert text =~ "capped at 1000"
    refute String.contains?(text, String.duplicate("x", 2_000))
  end
end
