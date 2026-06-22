defmodule SpellAgent.BrushNifTest do
  @moduledoc """
  Integration gate for the brush NIF (PLAN-011 W0).

  Proves the three contracts that the Rust unit tests cannot reach because they
  need a real running command: (1) the NIF loads and runs a command end-to-end,
  (2) shell injection is neutralized AT EXECUTION (not just in the AST), and
  (3) the safety nets (timeout, bad input) return DATA, never a crash.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.BrushNif

  describe "run/3 basic execution" do
    test "captures stdout and exit code" do
      result = BrushNif.run(["echo", "hi"], %{}, %{})
      assert result["exit"] == 0
      assert result["out"] == "hi\n"
      assert result["err"] == ""
    end

    test "non-zero exit is surfaced as data" do
      result = BrushNif.run(["false"], %{}, %{})
      assert result["exit"] == 1
    end

    test "passes environment through" do
      result = BrushNif.run(["printenv", "SPELL_TEST_VAR"], %{"SPELL_TEST_VAR" => "xyz"}, %{})
      assert result["out"] == "xyz\n"
    end
  end

  describe "injection neutralization (the inject-proof contract)" do
    test "command separators stay literal" do
      # If `;` re-tokenized, this would run `rm`. It must print the literal text.
      result = BrushNif.run(["echo", "; rm -rf /"], %{}, %{})
      assert result["out"] == "; rm -rf /\n"
      assert result["exit"] == 0
    end

    test "command substitution is NOT expanded" do
      result = BrushNif.run(["echo", "$(date)"], %{}, %{})
      assert result["out"] == "$(date)\n"
    end

    test "variable expansion is NOT performed" do
      result = BrushNif.run(["echo", "${HOME}"], %{}, %{})
      assert result["out"] == "${HOME}\n"
    end

    test "glob is NOT expanded" do
      result = BrushNif.run(["echo", "*"], %{}, %{})
      assert result["out"] == "*\n"
    end

    test "brace expansion is NOT performed" do
      # In bash `echo {a,b}` -> "a b"; single-quoting must keep it literal.
      result = BrushNif.run(["echo", "{a,b}"], %{}, %{})
      assert result["out"] == "{a,b}\n"
    end

    test "tilde is NOT expanded" do
      result = BrushNif.run(["echo", "~"], %{}, %{})
      assert result["out"] == "~\n"
    end
  end

  describe "output capture" do
    test "large output (>64KB) survives — the temp-file-over-pipe rationale" do
      # A pipe's ~64KB buffer would deadlock without a concurrent drainer; temp
      # files have no such limit. 50k lines is well past the pipe buffer.
      result = BrushNif.run(["seq", "1", "50000"], %{}, %{})
      assert result["exit"] == 0
      assert length(String.split(result["out"], "\n", trim: true)) == 50_000
    end

    test "stdout and stderr are captured separately" do
      result = BrushNif.run(["sh", "-c", "echo OUT; echo ERR >&2"], %{}, %{})
      assert result["out"] =~ "OUT"
      assert result["err"] =~ "ERR"
    end
  end

  describe "safety nets (never brick)" do
    test "timeout returns exit 124 within budget" do
      {micros, result} =
        :timer.tc(fn -> BrushNif.run(["sleep", "5"], %{}, %{"timeout_ms" => 100}) end)

      assert result["exit"] == 124
      assert result["err"] =~ "timeout"
      # Generous ceiling: the command was bounded, not run to completion.
      assert micros < 2_000_000
    end

    test "empty argv returns an error code, not a crash" do
      result = BrushNif.run([], %{}, %{})
      assert result["exit"] == 2
    end

    test "timed-out command does NOT orphan its child process" do
      # The child writes a sentinel file AFTER a sleep that outlives the
      # timeout. If brush's cancellation killed the child (no orphan), the
      # sentinel never appears even after we wait past the would-be write.
      sentinel = Path.join(System.tmp_dir!(), "brush_orphan_#{System.unique_integer([:positive])}")
      on_exit(fn -> File.rm(sentinel) end)

      result =
        BrushNif.run(["sh", "-c", "sleep 1; touch #{sentinel}"], %{}, %{"timeout_ms" => 100})

      assert result["exit"] == 124
      # Wait well past when the orphaned child WOULD have written the sentinel.
      Process.sleep(1500)
      refute File.exists?(sentinel), "child was orphaned past the timeout (process leak)"
    end
  end

  describe "parse/unparse (W5 — smoke; full coverage in sh_parse_test)" do
    test "parse returns {:ok, tree} for valid bash" do
      assert {:ok, %{"node" => "program"}} = BrushNif.parse("ls | wc -l")
    end

    test "unparse returns {:ok, bash} for a tree" do
      {:ok, tree} = BrushNif.parse("echo hi")
      assert {:ok, bash} = BrushNif.unparse(tree)
      assert bash =~ "echo"
    end
  end
end
