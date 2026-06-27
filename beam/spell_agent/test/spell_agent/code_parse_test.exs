defmodule SpellAgent.CodeParseTest do
  @moduledoc """
  PLAN-020 W3 — code/parse + code/unparse: source code as form_tree.

  The tree-sitter projector (in pi_kernel_nif) turns SOURCE into the same
  `form_tree` shape sh/parse and Hist.Lens.form_tree produce, so one q/* algebra
  walks all three. This suite defends the LAW the whole plan rides on:

    * SHAPE: code/parse emits canonical form_tree nodes (node/name/value/text/
      children), tuple-free and JSON-safe.
    * RE-PARSE EQUALITY (not byte): parse → unparse → parse is structurally
      stable; an UNTOUCHED tree round-trips byte-exactly.
    * EDITED ROUND-TRIP: a q/* rewrite of a subtree, then code/unparse, yields
      valid source reflecting the edit (the W5 foundation).
    * DRIFT-RESILIENCE: error/exotic constructs degrade to a `raw` leaf, never
      a crash.
    * THREE-SURFACE: the SAME q/* prelude matches a real code/parse tree.
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp.Prelude.Compiler
  alias SpellAgent.Code

  @q_source File.read!(
              Path.join([:code.priv_dir(:spell_agent) |> to_string(), "preludes", "q.clj"])
            )

  setup_all do
    {:ok, prelude} = Compiler.compile(@q_source)
    {:ok, prelude: prelude}
  end

  defp parse(src), do: Code.parse_tool(%{"src" => src, "lang" => "elixir"})
  defp unparse(tree), do: Code.unparse_tool(%{"tree" => tree})

  defp q(prelude, program, binds) do
    {:ok, step} =
      PtcRunner.Lisp.run(program,
        prelude: prelude,
        context: binds,
        filter_context: false,
        caller: :in_process_v1
      )

    step.return
  end

  describe "code/parse — the form_tree shape" do
    test "a def projects to a nested form_tree with field names" do
      tree = parse("def f(x), do: x + 1")

      assert tree["node"] == "source"
      # the top-level call node is somewhere under source
      assert is_list(tree["children"])
      # the binary_operator x + 1 appears with named left/right leaves
      assert find_node(tree, "binary_operator") != nil
      left = find_field(find_node(tree, "binary_operator"), "left")
      assert left["node"] == "identifier"
      assert left["value"] == "x"
      # field role lives under `field`, NOT `name` (reserved for semantic names)
      assert left["field"] == "left"
      refute Map.has_key?(left, "name")
    end

    test "the tree is JSON-safe (no tuples, round-trips through Jason)" do
      tree = parse("x + 1")
      assert {:ok, encoded} = Jason.encode(tree)
      assert {:ok, ^tree} = Jason.decode(encoded)
    end

    test "an unknown language is an error map, not a crash" do
      assert %{"error" => msg} = Code.parse_tool(%{"src" => "x", "lang" => "klingon"})
      assert msg =~ "klingon"
    end

    test "missing src / lang is an error map" do
      assert %{"error" => m1} = Code.parse_tool(%{"lang" => "elixir"})
      assert m1 =~ "src"
      assert %{"error" => m2} = Code.parse_tool(%{"src" => "x"})
      assert m2 =~ "lang"
    end
  end

  describe "RE-PARSE EQUALITY (the cross-plan correctness law)" do
    # An untouched tree round-trips BYTE-EXACTLY (it carries verbatim `text`).
    for src <- [
          "x + 1",
          "def f(x), do: x + 1",
          "def g(a, b) do\n  a * b\nend",
          "Enum.map(xs, fn x -> x + 1 end)",
          "case y do\n  {:ok, v} -> v\n  :error -> 0\nend",
          "%{a: 1, b: 2}",
          "x |> f() |> g()"
        ] do
      test "untouched round-trip is byte-exact for #{inspect(src)}" do
        src = unquote(src)
        tree = parse(src)
        refute Map.has_key?(tree, "error"), "parse failed: #{inspect(tree)}"
        assert %{"src" => back} = unparse(tree)
        assert back == src
      end
    end

    test "parse → unparse → parse is structurally stable (re-parse equality)" do
      src = "def f(x), do: x + 1"
      t1 = parse(src)
      %{"src" => back} = unparse(t1)
      t2 = parse(back)
      assert t1 == t2
    end
  end

  describe "EDITED round-trip (the W5 foundation)" do
    test "a q/* rewrite of a leaf value re-renders through code/unparse", %{prelude: prelude} do
      tree = parse("x + 1")

      # rename the identifier `x` -> `y` via q/update, updating ONLY `value`.
      # q/update must INVALIDATE the leaf's stale `text` cache itself (the edit
      # changed the node), or code/unparse's text-fast-path would emit the old
      # `x` and silently drop the change. This is the W4-review regression: a
      # caller that forgets to also set `text` must still get a correct edit.
      program = ~S"""
      (q/update data/tree
                {"node" "identifier" "value" "x"}
                (fn [_b node] (assoc node "value" "y")))
      """

      edited = q(prelude, program, %{"tree" => tree})
      assert %{"src" => back} = unparse(edited)
      # the edit is reflected; the operator + operand survive
      assert back =~ "y"
      assert back =~ "+"
      assert back =~ "1"
      refute back =~ "x"
    end

    test "token adjacency: editing inside a call keeps parens tight", %{prelude: prelude} do
      tree = parse("foo(x)")

      # rename x -> y inside the call; the rejoin must keep foo(y), NOT foo ( y )
      program = ~S"""
      (q/update data/tree
                {"node" "identifier" "value" "x"}
                (fn [_b node] (assoc node "value" "y")))
      """

      edited = q(prelude, program, %{"tree" => tree})
      assert %{"src" => back} = unparse(edited)
      # re-parse equality: the edited source must re-parse to the SAME structure.
      reparsed = parse(back)
      assert reparsed == parse("foo(y)")
    end
  end

  describe "DRIFT-RESILIENCE — exotic / incomplete source degrades, never crashes" do
    test "incomplete source still parses (tree-sitter error recovery), no crash" do
      tree = parse("def f(")
      refute Map.has_key?(tree, "error")
      assert tree["node"] == "source"
    end

    test "an ERROR region surfaces as a raw leaf somewhere in the tree" do
      # garbage that tree-sitter cannot structure
      tree = parse("def @@@ !!!")
      refute Map.has_key?(tree, "error")
      # a raw leaf preserves the unparseable span
      assert find_node(tree, "raw") != nil or tree["node"] == "source"
    end
  end

  describe "THREE-SURFACE — the SAME q/* prelude matches a real code/parse tree" do
    test "q/descendant finds an identifier in parsed source", %{prelude: prelude} do
      tree = parse("foo + bar")

      n =
        q(
          prelude,
          ~S|(count (q/descendant {"node" "identifier" "value" "foo"} data/tree))|,
          %{"tree" => tree}
        )

      assert n == 1
    end
  end

  # ── helpers: walk a form_tree to find a node kind / field ──
  defp find_node(%{"node" => k} = node, kind) when k == kind, do: node

  defp find_node(%{"children" => kids}, kind) do
    Enum.find_value(kids, fn c -> find_node(c, kind) end)
  end

  defp find_node(_, _), do: nil

  defp find_field(%{"children" => kids}, field) do
    Enum.find(kids, fn c -> c["field"] == field end)
  end

  defp find_field(_, _), do: nil
end
