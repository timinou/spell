defmodule SpellAgent.Tui.CodeEditTerminalTest do
  @moduledoc """
  PLAN-022 S1 — the lispy code/edit surface, rendered in the REAL inspector TUI.

  Drives the production inspector `App` through a real headless terminal, fed by a
  SCRIPTED (network-free, no cassette) llm that emits a `code-apply` codemod
  program. The real agent loop runs it: read a fixture file -> code-parse ->
  q/apply-ops (rename an identifier) -> parse-gate -> write. The test asserts the
  rendered screen (the span tree + run detail the live inspector draws) SHOWS the
  codemod run.

  This is the agent's CODEMOD REASONING shown as the user sees it — the visual
  half of the showcase (the stdout half is `mix spell.codemod`). Deterministic +
  offline: the scripted llm is a pure `(request -> {:ok, resp})` callback, and the
  codemod runs over a tmp fixture.

  Assertion shape: the behavioural contract (file rewritten, mission ok) is exact;
  the visual contract is CONTENT-presence (the codemod turn + tool span + ok
  status appear), NOT a byte-exact golden — a rendered-transcript byte-golden over
  a live agent loop is timing-fragile (a variable-width duration shifts column
  padding under load; the same FUP-026 class). Content assertions pin the
  showcase's actual value (the codemod reasoning is VISIBLE) without the flake.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.LlmTerminal

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

  describe "Design A — codemod visual showcase" do
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

      # --- the behavioural contract (deterministic) ---
      # the mission completed (the loop terminated on the final-answer turn).
      assert {:ok, _} = out.result
      # the codemod actually ran end-to-end: the file was rewritten x -> y, and
      # was NOT rolled back (the FUP-027 finalizer correctly classifies the
      # implicit-return codemod turn as success).
      src = File.read!(path)
      assert src =~ "y"
      refute src =~ ~r/\bx\b/

      # --- the visual contract (the showcase) ---
      # The inspector rendered the codemod run: the span tree shows the two turns,
      # the code-apply tool span, and an ok run status. We assert CONTENT presence
      # (resilient to the column-padding a variable-width duration introduces),
      # not a byte-exact golden — a rendered-transcript byte-golden over a live
      # agent loop is timing-fragile (see FUP-026), and the showcase's value is
      # that the codemod reasoning is VISIBLE, which content assertions pin.
      buffer = out.buffer
      assert buffer =~ "spell · inspector"
      assert buffer =~ "turns 2 · tools 1"
      # the codemod turn + its tool span are drawn in the span tree
      assert buffer =~ "tool/code-appl"
      assert buffer =~ "code-apply"
      # the run settled ok (no ✗ / failure marker on the run)
      assert buffer =~ "status: ok"
    end
  end
end
