defmodule SpellAgent.ShPipeTest do
  @moduledoc """
  Contract tests for the `sh-pipe` byte-pipeline tool (PLAN-011 W4).

  Verifies: brush connects stdout->stdin between stages, each stage is
  inject-proof, validation rejects malformed pipelines, and the result shape
  matches single-command `sh`. Plus end-to-end through the PTC tool boundary.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Sh
  alias SpellAgent.BrushNif

  describe "byte-pipe semantics (NIF level)" do
    test "two stages stream stdout->stdin" do
      r = BrushNif.pipe([["printf", "a\\nb\\nc\\n"], ["wc", "-l"]], %{}, %{})
      assert r["exit"] == 0
      assert String.trim(r["out"]) == "3"
    end

    test "three stages compose" do
      r = BrushNif.pipe([["printf", "x\\ny\\nERR\\n"], ["grep", "ERR"], ["wc", "-l"]], %{}, %{})
      assert String.trim(r["out"]) == "1"
    end

    test "pipeline exit is the last stage's exit" do
      r = BrushNif.pipe([["echo", "hi"], ["false"]], %{}, %{})
      assert r["exit"] == 1
    end
  end

  describe "injection neutralized per stage" do
    test "metacharacters in a stage stay literal" do
      r = BrushNif.pipe([["echo", "; rm -rf /"], ["cat"]], %{}, %{})
      assert r["out"] == "; rm -rf /\n"
    end

    test "command substitution is not expanded in any stage" do
      r = BrushNif.pipe([["echo", "$(date)"], ["cat"]], %{}, %{})
      assert r["out"] == "$(date)\n"
    end
  end

  describe "sh-pipe tool validation" do
    test "missing stages is an error map" do
      assert %{"error" => msg} = Sh.pipe_tool(%{})
      assert msg =~ "stages"
    end

    test "empty stages list is rejected" do
      assert %{"error" => msg} = Sh.pipe_tool(%{"stages" => []})
      assert msg =~ "non-empty"
    end

    test "an empty stage is rejected with its index" do
      assert %{"error" => msg} = Sh.pipe_tool(%{"stages" => [["cat"], []]})
      assert msg =~ "stage 1"
    end

    test "a non-string element in a stage reports stage + index" do
      assert %{"error" => msg} = Sh.pipe_tool(%{"stages" => [["echo", 5]]})
      assert msg =~ "stage 0"
    end
  end

  describe "sh-pipe tool result shape matches sh" do
    test "returns exit/out/err/lines" do
      r = Sh.pipe_tool(%{"stages" => [["printf", "a\\nb\\n"], ["cat"]]})
      assert r["exit"] == 0
      assert r["lines"] == ["a", "b"]
      assert r["err"] == ""
    end
  end

  describe "end-to-end via the PTC tool boundary" do
    setup do
      case SpellAgent.ToolRegistry.start_link([]) do
        {:ok, _} -> :ok
        {:error, {:already_started, _}} -> :ok
      end

      :ok
    end

    test "(tool/sh-pipe {:stages [...]}) runs through the evaluator" do
      tools = SpellAgent.Tools.build_tools_map()
      src = ~S|(:out (tool/sh-pipe {:stages [["printf" "a\nb\nc\n"] ["wc" "-l"]]}))|
      {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert String.trim(step.return) == "3"
    end

    test "pipeline composes with Lisp combinators" do
      tools = SpellAgent.Tools.build_tools_map()
      src = ~S|(count (:lines (tool/sh-pipe {:stages [["printf" "1\n2\n3\n4\n"] ["cat"]]})))|
      {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert step.return == 4
    end
  end

  describe "pipeline options and safety (review gaps)" do
    test "NUL byte in a stage element is rejected with stage + index" do
      assert %{"error" => msg} = Sh.pipe_tool(%{"stages" => [["echo", "a\0b"], ["cat"]]})
      assert msg =~ "stage 0"
      assert msg =~ "NUL"
    end

    test "cwd applies to the pipeline" do
      tmp = System.tmp_dir!()
      r = Sh.pipe_tool(%{"stages" => [["pwd"], ["cat"]], "cwd" => tmp})
      assert Path.basename(String.trim(r["out"])) == Path.basename(tmp)
    end

    test "env applies to the pipeline" do
      r =
        Sh.pipe_tool(%{
          "stages" => [["printenv", "PIPE_VAR"], ["cat"]],
          "env" => %{"PIPE_VAR" => "v"}
        })

      assert String.trim(r["out"]) == "v"
    end

    test "a multi-stage pipeline timeout returns 124 (not a generic error)" do
      # Regression for the W4 review finding: a non-last stage timing out used
      # to surface as exit 1 (brush: interrupted). It must be 124.
      r = BrushNif.pipe([["sleep", "10"], ["cat"]], %{}, %{"timeout_ms" => 150})
      assert r["exit"] == 124
      assert r["err"] =~ "timeout"
    end

    test "a timed-out pipeline does not orphan a later-stage child" do
      sentinel = Path.join(System.tmp_dir!(), "pipe_orphan_#{System.unique_integer([:positive])}")
      on_exit(fn -> File.rm(sentinel) end)

      BrushNif.pipe(
        [["echo", "go"], ["sh", "-c", "sleep 1; touch #{sentinel}"]],
        %{},
        %{"timeout_ms" => 100}
      )

      Process.sleep(1500)
      refute File.exists?(sentinel), "a later pipeline stage leaked past the timeout"
    end

    test "large piped payload streams through (no pipe-buffer deadlock)" do
      r = BrushNif.pipe([["seq", "1", "50000"], ["wc", "-l"]], %{}, %{})
      assert r["exit"] == 0
      assert String.trim(r["out"]) == "50000"
    end
  end
end
