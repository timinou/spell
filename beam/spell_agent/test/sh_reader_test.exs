defmodule SpellAgent.ShReaderTest do
  @moduledoc """
  Tests for the `sh::` reader form (PLAN-011 W2).

  The central contract (the "modularity oracle"): `sh::` is PURE SUGAR — it
  parses to the exact same AST as the hand-written `(tool/sh {:argv [...]})`
  call. Plus desugar edge cases and end-to-end execution through the evaluator.
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp.FastParser

  defp parse!(src) do
    {:ok, ast} = FastParser.parse(src)
    ast
  end

  describe "desugar equivalence (the modularity oracle)" do
    test "bare words + unquote == hand-written tool/sh map call" do
      a = parse!(~S|(sh:: rg -l TODO ~dir)|)
      b = parse!(~S|(tool/sh {:argv ["rg" "-l" "TODO" dir]})|)
      assert a == b
    end

    test "all bare words desugar to a string vector" do
      a = parse!(~S|(sh:: echo hello world)|)
      b = parse!(~S|(tool/sh {:argv ["echo" "hello" "world"]})|)
      assert a == b
    end

    test "flags and globs are literal string elements" do
      a = parse!(~S|(sh:: ls -la *.ex)|)
      b = parse!(~S|(tool/sh {:argv ["ls" "-la" "*.ex"]})|)
      assert a == b
    end

    test "quoted string token preserves spaces" do
      a = parse!(~S|(sh:: echo "a b c")|)
      b = parse!(~S|(tool/sh {:argv ["echo" "a b c"]})|)
      assert a == b
    end
  end

  describe "unquote and splice" do
    test "~form unquotes one Lisp value as a single element" do
      a = parse!(~S|(sh:: echo ~(str "x" "y"))|)
      b = parse!(~S|(tool/sh {:argv ["echo" (str "x" "y")]})|)
      assert a == b
    end

    test "~@form desugars to (vec (concat ...)) segments" do
      a = parse!(~S|(sh:: rg ~@flags)|)
      b = parse!(~S|(tool/sh {:argv (vec (concat ["rg"] flags))})|)
      assert a == b
    end

    test "mixed plain + splice keeps order via concat segments" do
      a = parse!(~S|(sh:: rg ~@flags src)|)
      b = parse!(~S|(tool/sh {:argv (vec (concat ["rg"] flags ["src"]))})|)
      assert a == b
    end
  end

  describe "reader errors (never crash)" do
    test "unclosed sh:: form is a clean error, not a crash" do
      assert {:error, msg} = FastParser.parse(~S|(sh:: rg -l TODO|)
      assert msg =~ "sh::" or msg =~ "unclosed"
    end

    test "empty sh:: body desugars to an empty argv" do
      a = parse!(~S|(sh::)|)
      b = parse!(~S|(tool/sh {:argv []})|)
      assert a == b
    end
  end

  describe "a normal symbol starting with sh is unaffected" do
    test "(shell-thing ...) is a plain call, not a sh:: form" do
      ast = parse!(~S|(shout "hi")|)
      # unknown symbols intern as strings in this parser; the point is it is NOT a sh:: form
      assert {:list, [{:symbol, _}, {:string, "hi"}]} = ast
    end
  end

  describe "end-to-end execution" do
    setup do
      case SpellAgent.ToolRegistry.start_link([]) do
        {:ok, _} -> :ok
        {:error, {:already_started, _}} -> :ok
      end

      :ok
    end

    defp run!(src, opts \\ []) do
      tools = SpellAgent.Tools.build_tools_map()
      base = [tools: tools, caller: :in_process_v1]
      {:ok, step} = PtcRunner.Lisp.run(src, Keyword.merge(base, opts))
      step.return
    end

    test "(sh:: echo hello) runs and returns structured output" do
      assert run!(~S|(:out (sh:: echo hello))|) == "hello\n"
    end

    test "~unquote of a let binding becomes one argv element" do
      assert run!(~S|(let [msg "world"] (:out (sh:: echo ~msg)))|) == "world\n"
    end

    test "injection via ~unquote stays literal" do
      assert run!(~S|(:out (sh:: echo ~data/x))|, context: %{"x" => "$(date)"}) == "$(date)\n"
    end

    test "~@splice expands a list into argv" do
      assert run!(~S|(let [args ["hello" "world"]] (:lines (sh:: echo ~@args)))|) == ["hello world"]
    end
  end

  describe "vision capstone: write + compose + remember" do
    setup do
      case SpellAgent.ToolRegistry.start_link([]) do
        {:ok, _} -> :ok
        {:error, {:already_started, _}} -> :ok
      end

      :ok
    end

    test "validate accepts sh:: source (the define-tool path)" do
      assert :ok == PtcRunner.Lisp.validate(~S|(:lines (sh:: rg -l TODO ~data/dir))|)
    end

    test "a defined tool wrapping sh:: is callable (remember foundation)" do
      SpellAgent.Tools.define_tool(%{
        "name" => "echo-dir",
        "params" => ["dir"],
        "source" => ~S|(:lines (sh:: echo ~data/dir))|
      })

      tools = SpellAgent.Tools.build_tools_map()
      {:ok, s} = PtcRunner.Lisp.run(~S|(tool/echo-dir {:dir "hello"})|, tools: tools, caller: :in_process_v1)
      assert s.return == ["hello"]
    end

    test "sh:: output composes with Lisp combinators (->> + map)" do
      SpellAgent.Tools.define_tool(%{
        "name" => "echo-dir2",
        "params" => ["dir"],
        "source" => ~S|(:lines (sh:: echo ~data/dir))|
      })

      tools = SpellAgent.Tools.build_tools_map()
      src = ~S|(->> (tool/echo-dir2 {:dir "a"}) (map clojure.string/upper-case))|
      {:ok, s} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert s.return == ["A"]
    end
  end
end
