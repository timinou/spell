defmodule SpellAgent.ShParseTest do
  @moduledoc """
  Tests for sh-parse / sh-unparse — bash as walkable data (PLAN-011 W5).

  Central contracts: parse produces form_tree-shaped (tuple-free, JSON-safe)
  nodes; the round-trip is SEMANTICALLY stable (re-parse equality); unparse
  re-escapes so it can never reintroduce injection; exotic bash degrades to a
  `raw` leaf rather than failing.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.BrushNif
  alias SpellAgent.Sh

  describe "parse produces the form_tree shape" do
    test "a simple command projects to a command node with word children" do
      {:ok, tree} = BrushNif.parse("rg -l TODO")
      assert %{"node" => "program", "children" => [cmd]} = tree
      assert %{"node" => "command", "name" => "rg", "children" => words} = cmd
      assert Enum.map(words, & &1["value"]) == ["-l", "TODO"]
    end

    test "a pipeline projects to a pipeline node" do
      {:ok, tree} = BrushNif.parse("a | b | c")
      assert %{"children" => [%{"node" => "pipeline", "children" => stages}]} = tree
      assert length(stages) == 3
      assert Enum.map(stages, & &1["name"]) == ["a", "b", "c"]
    end

    test "&& / || project to an and_or node" do
      {:ok, tree} = BrushNif.parse("a && b || c")
      assert %{"children" => [%{"node" => "and_or", "children" => parts}]} = tree
      assert [%{"name" => "a"}, %{"node" => "and"}, %{"node" => "or"}] = parts
    end

    test "word values are LOGICAL (quotes removed)" do
      {:ok, tree} = BrushNif.parse(~s|echo "hello world"|)
      assert %{"children" => [%{"children" => [word]}]} = tree
      assert word["value"] == "hello world"
    end

    test "the tree is JSON-safe (no tuples)" do
      {:ok, tree} = BrushNif.parse("rg -l TODO | head")
      # A round-trip through JSON is the strongest tuple-free assertion.
      assert {:ok, encoded} = Jason.encode(tree)
      assert {:ok, ^tree} = Jason.decode(encoded)
    end
  end

  describe "round-trip is semantically stable (re-parse equality)" do
    for src <- [
          "rg -l TODO | head",
          "echo hello world",
          "a && b || c",
          "cat f; grep x; wc -l",
          "ls -la",
          ~s|echo "a b c"|
        ] do
      test "re-parse equality for #{inspect(src)}" do
        src = unquote(src)
        {:ok, t1} = BrushNif.parse(src)
        {:ok, bash} = BrushNif.unparse(t1)
        {:ok, t2} = BrushNif.parse(bash)
        assert t1 == t2, "#{inspect(src)} -> #{inspect(bash)} did not re-parse identically"
      end
    end
  end

  describe "unparse cannot reintroduce injection" do
    test "a metacharacter word is re-escaped to one literal argument" do
      # Hand-build a tree whose word carries an injection payload.
      tree = %{
        "node" => "program",
        "children" => [
          %{
            "node" => "command",
            "name" => "echo",
            "children" => [%{"node" => "word", "value" => "; rm -rf /"}]
          }
        ]
      }

      {:ok, bash} = BrushNif.unparse(tree)
      # Running it must print the literal text, not execute rm.
      r = Sh.tool(%{"argv" => ["sh", "-c", bash]})
      assert r["out"] == "; rm -rf /\n"
    end
  end

  describe "exotic bash degrades to a raw leaf" do
    test "a for-loop is preserved as raw, not an error" do
      assert {:ok, tree} = BrushNif.parse("for f in *.ex; do echo $f; done")
      assert %{"children" => [%{"node" => "raw", "value" => raw}]} = tree
      assert raw =~ "for f"
    end

    test "a raw leaf round-trips verbatim" do
      {:ok, t1} = BrushNif.parse("if true; then echo hi; fi")
      {:ok, bash} = BrushNif.unparse(t1)
      {:ok, t2} = BrushNif.parse(bash)
      assert t1 == t2
    end
  end

  describe "error handling" do
    test "malformed bash returns an error tuple, not a crash" do
      # An unterminated quote is a genuine parse error.
      assert {:error, _reason} = BrushNif.parse(~s|echo "unterminated|)
    end
  end

  describe "tool surface" do
    test "sh-parse tool returns the tree" do
      tree = Sh.parse_tool(%{"src" => "echo hi"})
      assert %{"node" => "program"} = tree
    end

    test "sh-parse missing src is an error map" do
      assert %{"error" => msg} = Sh.parse_tool(%{})
      assert msg =~ "src"
    end

    test "sh-unparse tool returns bash" do
      {:ok, tree} = BrushNif.parse("echo hi")
      assert %{"bash" => bash} = Sh.unparse_tool(%{"tree" => tree})
      assert bash =~ "echo"
    end

    test "sh-parse and sh-unparse compose end-to-end via PTC" do
      case SpellAgent.ToolRegistry.start_link([]) do
        {:ok, _} -> :ok
        {:error, {:already_started, _}} -> :ok
      end

      tools = SpellAgent.Tools.build_tools_map()
      src = ~S|(:bash (tool/sh-unparse {:tree (tool/sh-parse {:src "echo hi"})}))|
      {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert step.return =~ "echo"
    end
  end

  describe "round-trip idempotency for quote-containing and empty words (review fixes)" do
    for src <- [
          ~S|echo "it's"|,
          ~S|echo it\'s|,
          "echo ''",
          ~S|echo "a'b"|,
          ~S|grep "needs space"|
        ] do
      test "re-parse equality for #{inspect(src)}" do
        src = unquote(src)
        {:ok, t1} = BrushNif.parse(src)
        {:ok, bash} = BrushNif.unparse(t1)
        {:ok, t2} = BrushNif.parse(bash)
        assert t1 == t2
      end
    end

    test "a single-quote-containing word keeps its logical value" do
      {:ok, tree} = BrushNif.parse(~S|echo "it's"|)
      %{"children" => [%{"children" => [w]}]} = tree
      assert w["value"] == "it's"
    end

    test "an empty word round-trips" do
      {:ok, t1} = BrushNif.parse("echo ''")
      %{"children" => [%{"children" => [w]}]} = t1
      assert w["value"] == ""
      {:ok, bash} = BrushNif.unparse(t1)
      {:ok, t2} = BrushNif.parse(bash)
      assert t1 == t2
    end
  end

  describe "prefix assignments preserved (review fix)" do
    test "FOO=bar echo hi degrades to raw, not a reordered command" do
      {:ok, tree} = BrushNif.parse("FOO=bar echo hi")
      assert %{"children" => [%{"node" => "raw", "value" => raw}]} = tree
      assert raw =~ "FOO=bar"
      # round-trip preserves the assignment semantics
      {:ok, bash} = BrushNif.unparse(tree)
      {:ok, t2} = BrushNif.parse(bash)
      assert tree == t2
    end
  end

  describe "panic-safety: deep nesting does not crash the VM (review fix)" do
    test "a deeply nested hand-built tree is bounded, not a stack overflow" do
      # Build a tree far deeper than MAX_DEPTH (256). unparse must return,
      # not abort the BEAM.
      deep =
        Enum.reduce(1..2000, %{"node" => "word", "value" => "x"}, fn _, acc ->
          %{"node" => "pipeline", "children" => [acc]}
        end)

      assert {:ok, _bash} = BrushNif.unparse(deep)
    end
  end

  describe "raw nodes render verbatim (documented trust boundary)" do
    test "a raw node is emitted as-is (not escaped)" do
      tree = %{"node" => "program", "children" => [%{"node" => "raw", "value" => "echo $HOME"}]}
      assert {:ok, "echo $HOME"} = BrushNif.unparse(tree)
    end
  end

  describe "decode robustness" do
    test "a non-string value does not crash unparse" do
      tree = %{"node" => "program", "children" => [%{"node" => "word", "value" => 42}]}
      # 42 is not a string; decode drops it to empty rather than crashing.
      assert {:ok, _bash} = BrushNif.unparse(tree)
    end
  end
end
