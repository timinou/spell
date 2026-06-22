defmodule SpellAgent.ShTest do
  @moduledoc """
  Contract tests for the `sh` tool (PLAN-011 W1).

  Two layers: (1) `SpellAgent.Sh.tool/1` directly (the validation + result-map
  contract), and (2) end-to-end through the PTC tool boundary, proving
  `(tool/sh {:argv [...]})` runs and that injection is neutralized through the
  whole stack — not just in the NIF.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Sh

  describe "result contract" do
    test "returns exit/out/err/lines for a successful command" do
      r = Sh.tool(%{"argv" => ["printf", "a\\nb\\n"]})
      assert r["exit"] == 0
      assert r["lines"] == ["a", "b"]
      assert r["err"] == ""
    end

    test "non-zero exit is data, not a raise" do
      r = Sh.tool(%{"argv" => ["false"]})
      assert r["exit"] == 1
    end
  end

  describe "argv validation" do
    test "missing argv is an error map naming the field" do
      assert %{"error" => msg} = Sh.tool(%{})
      assert msg =~ "argv"
    end

    test "empty argv is rejected" do
      assert %{"error" => msg} = Sh.tool(%{"argv" => []})
      assert msg =~ "non-empty"
    end

    test "non-string element reports the offending index" do
      assert %{"error" => msg} = Sh.tool(%{"argv" => ["echo", 5]})
      assert msg =~ "element 1"
    end

    test "NUL byte in an element is rejected" do
      assert %{"error" => msg} = Sh.tool(%{"argv" => ["echo", "a\0b"]})
      assert msg =~ "NUL"
    end

    test "bad timeout is rejected with a clear message" do
      assert %{"error" => msg} = Sh.tool(%{"argv" => ["echo", "hi"], "timeout-ms" => -1})
      assert msg =~ "timeout"
    end
  end

  describe "options" do
    test "cwd changes the working directory" do
      tmp = System.tmp_dir!()
      r = Sh.tool(%{"argv" => ["pwd"], "cwd" => tmp})
      assert Path.basename(String.trim(r["out"])) == Path.basename(tmp)
    end

    test "env overrides are passed through" do
      r = Sh.tool(%{"argv" => ["printenv", "SH_TEST"], "env" => %{"SH_TEST" => "v"}})
      assert String.trim(r["out"]) == "v"
    end

    test "timeout returns exit 124" do
      r = Sh.tool(%{"argv" => ["sleep", "5"], "timeout-ms" => 100})
      assert r["exit"] == 124
    end
  end

  describe "injection neutralized through the tool layer" do
    test "metacharacters stay literal" do
      r = Sh.tool(%{"argv" => ["echo", "; rm -rf / | cat $(whoami)"]})
      assert r["out"] == "; rm -rf / | cat $(whoami)\n"
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

    test "(tool/sh {:argv [...]}) runs and returns the structured map" do
      tools = SpellAgent.Tools.build_tools_map()
      src = ~S|(tool/sh {:argv ["echo" "hi"]})|
      assert {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert step.return["exit"] == 0
      assert step.return["lines"] == ["hi"]
    end

    test "injection stays literal end-to-end through PTC" do
      tools = SpellAgent.Tools.build_tools_map()
      src = ~S|(tool/sh {:argv ["echo" "$(date)"]})|
      assert {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert step.return["out"] == "$(date)\n"
    end

    test ":lines composes with Lisp combinators" do
      tools = SpellAgent.Tools.build_tools_map()
      src = ~S|(count (:lines (tool/sh {:argv ["printf" "a\nb\nc\n"]})))|
      assert {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert step.return == 3
    end

    test "kebab-case :timeout-ms opt flows through the PTC boundary" do
      tools = SpellAgent.Tools.build_tools_map()
      src = ~S|(tool/sh {:argv ["sleep" "5"] :timeout-ms 100})|
      assert {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert step.return["exit"] == 124
    end

    test "kebab-case :cwd opt flows through the PTC boundary" do
      tools = SpellAgent.Tools.build_tools_map()
      tmp = System.tmp_dir!()
      src = ~s|(tool/sh {:argv ["pwd"] :cwd "#{tmp}"})|
      assert {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert Path.basename(String.trim(step.return["out"])) == Path.basename(tmp)
    end
  end
end
