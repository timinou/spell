defmodule SpellAgent.Tui.CodeEditTerminalTest do
  @moduledoc """
  PLAN-022 S1 — the lispy code/edit surface, rendered in the REAL inspector TUI.

  Drives the production inspector `App` through a real headless terminal, fed by a
  SCRIPTED (network-free, no cassette) llm that emits a `code-apply` codemod
  program. The real agent loop runs it: read a fixture file -> code-parse ->
  q/apply-ops (rename an identifier) -> parse-gate -> write. The rendered screen
  (the span tree + run detail the live inspector draws) is captured as a golden
  `.transcript` and asserted on replay, exactly like `llm_terminal_test`'s
  cassette-backed `answer_42` baseline.

  This is the agent's CODEMOD REASONING shown as the user sees it — the visual
  half of the showcase (the stdout half is `mix spell.codemod`). Deterministic +
  offline: the scripted llm is a pure `(request -> {:ok, resp})` callback, and the
  codemod runs over a tmp fixture, so the only volatile bits are the span
  ids/durations the transcript normalizer already masks.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.LlmTerminal

  @transcript_dir Path.join([__DIR__, "..", "..", "snapshots", "llm"])
  @snapshot "code_edit_codemod"

  setup do
    dir = Path.join(System.tmp_dir!(), "code_edit_terminal_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, dir: dir}
  end

  # A two-state scripted llm for the :tool_call transport. Turn 1 (no prior tool
  # result in the request) emits ONE lisp_eval call running the codemod program;
  # turn 2 (the loop calls back with the tool result) returns a final answer, so
  # the mission terminates. State is a tiny Agent counter (the loop calls the same
  # callback each turn; routing on turn index is the deterministic discriminator).
  defp scripted_codemod_llm(program) do
    {:ok, turn} = Agent.start_link(fn -> 0 end)

    fn _request ->
      n = Agent.get_and_update(turn, fn n -> {n, n + 1} end)

      resp =
        case n do
          0 ->
            %{
              tool_calls: [
                %{
                  id: "call_codemod_1",
                  name: "lisp_eval",
                  args: %{"program" => program}
                }
              ]
            }

          _ ->
            %{content: "Renamed the identifier. Done."}
        end

      {:ok, resp}
    end
  end

  describe "Design A — codemod visual transcript (golden)" do
    test "a code-apply codemod renders its run in the inspector", %{dir: dir} do
      path = Path.join(dir, "demo.ex")
      File.write!(path, "def add(x), do: x + 1\n")

      # The agent's program: rename identifier x -> y in the fixture via the
      # reified op-list (the canonical code-apply data path).
      program = """
      (tool/code-apply
        {:path "#{path}" :lang "elixir"
         :ops [{"op" "update"
                "pattern" {"node" "identifier" "value" "x"}
                "template" {"node" "identifier" "value" "y"}}]})
      """

      out =
        LlmTerminal.run_scenario("code_edit_codemod",
          prompt: "rename x to y in demo.ex",
          dimensions: {100, 30},
          llm: scripted_codemod_llm(program),
          max_turns: 4
        )

      # the mission completed (the loop terminated on the final-answer turn).
      assert {:ok, _} = out.result
      # the codemod actually ran: the file was rewritten.
      assert File.read!(path) =~ "y"

      # Golden transcript: the rendered screen, volatile fields masked.
      golden = Path.join(@transcript_dir, "#{@snapshot}.transcript")
      normalized = LlmTerminal.normalize_transcript(out.buffer)

      if File.exists?(golden) do
        assert normalized == File.read!(golden), """
        Codemod transcript mismatch for #{@snapshot}.

        If intended, delete #{golden} and re-run to rewrite the baseline, then
        review `git diff`.
        """
      else
        File.mkdir_p!(@transcript_dir)
        File.write!(golden, normalized)
        IO.puts("Wrote new codemod transcript baseline: #{golden}")
      end
    end
  end
end
