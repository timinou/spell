defmodule SpellAgent.LoopTest do
  @moduledoc """
  FEAT-045: A4 self-continuation. The mind ends a turn with a `loop/continue`
  signal; Session re-enters with the mind-authored next prompt (same session),
  bounded by a continue-depth cap so a runaway self-loop is impossible.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.{Loop, Session}
  alias SpellAgent.Hist.Store.Memory

  describe "the loop/continue verb" do
    test "produces the continuation signal carrying the prompt" do
      assert %{"__spell_loop_continue__" => "next"} = Loop.continue(%{"prompt" => "next"})
    end

    test "a missing/blank prompt is an error (a continue with no direction stalls)" do
      assert %{"error" => _} = Loop.continue(%{"prompt" => ""})
      assert %{"error" => _} = Loop.continue(%{})
    end

    test "signal/1 detects a continuation value, halts on anything else" do
      assert {:continue, "go"} = Loop.signal(Loop.continue(%{"prompt" => "go"}))
      assert Loop.signal(%{"other" => 1}) == :halt
      assert Loop.signal("a string") == :halt
    end

    test "a FORGED signal (tag present but not sole key) does NOT continue (S4 P2)" do
      # A tool result that merely contains the tag key must not be mistaken for a
      # genuine continue — only an EXACT single-key %{tag => prompt} continues.
      genuine = Loop.continue(%{"prompt" => "real"})
      forged = Map.put(genuine, "extra", 1)
      assert {:continue, _} = Loop.signal(genuine)
      assert Loop.signal(forged) == :halt
    end

    test "the verb is registered + callable from PTC" do
      tools = SpellAgent.Tools.build_tools_map()
      assert Map.has_key?(tools, "loop/continue")

      assert {:ok, step} =
               PtcRunner.Lisp.run(~S|(tool/loop/continue {:prompt "hi"})|,
                 tools: tools,
                 caller: :in_process_v1
               )

      assert {:continue, "hi"} = Loop.signal(step.return)
    end
  end

  describe "Session re-entry (the trampoline)" do
    test "a mission that returns a continue signal RE-ENTERS with the next prompt" do
      # First turn continues to a second; the second returns a plain value. Assert
      # BOTH prompts were seen (the continuation actually re-entered).
      test_pid = self()
      counter = :counters.new(1, [])

      llm = fn input ->
        n = :counters.get(counter, 1)
        :counters.add(counter, 1, 1)
        send(test_pid, {:turn, n, input})

        program =
          if n == 0 do
            ~S|(return (tool/loop/continue {:prompt "SECOND"}))|
          else
            ~S|(return "done")|
          end

        {:ok, lisp_eval(program)}
      end

      result =
        Session.run("FIRST",
          llm: llm,
          max_turns: 2,
          session_id: "loop-reentry-#{System.unique_integer([:positive])}",
          hist: Memory
        )

      assert {:ok, "done"} = result
      # exactly two missions ran (the continue re-entered once).
      assert :counters.get(counter, 1) == 2
    end

    test "a runaway self-continue is bounded by the depth cap (never infinite)" do
      # An llm that ALWAYS continues. Without the cap this would loop forever; with
      # it, the chain halts at max_continues with a surfaced note.
      counter = :counters.new(1, [])

      llm = fn _input ->
        :counters.add(counter, 1, 1)
        {:ok, lisp_eval(~S|(return (tool/loop/continue {:prompt "again"}))|)}
      end

      result =
        Session.run("start",
          llm: llm,
          max_turns: 1,
          session_id: "loop-runaway-#{System.unique_integer([:positive])}",
          hist: Memory
        )

      assert {:ok, %{"loop_halted" => _, "pending_prompt" => "again"}} = result
      # missions run = the initial + max_continues re-entries, and NO more.
      assert :counters.get(counter, 1) == Loop.max_continues() + 1
    end

    test "a normal (non-continue) mission passes through unchanged" do
      llm = fn _input -> {:ok, lisp_eval(~S|(return "plain")|)} end

      assert {:ok, "plain"} =
               Session.run("x",
                 llm: llm,
                 max_turns: 1,
                 session_id: "loop-plain-#{System.unique_integer([:positive])}",
                 hist: Memory
               )
    end
  end

  # The :tool_call transport carries the PTC program via a lisp_eval tool call.
  defp lisp_eval(program) do
    %{
      tool_calls: [
        %{id: "call_#{System.unique_integer([:positive])}", name: "lisp_eval", args: %{"program" => program}}
      ]
    }
  end
end
