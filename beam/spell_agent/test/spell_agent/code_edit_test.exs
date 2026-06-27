defmodule SpellAgent.CodeEditTest do
  @moduledoc """
  PLAN-020 W5 — code/edit: parse-gated, transactional, reified-xf.

  The agent builds an edited form_tree with q/* in its OWN program, then hands it
  to code-edit, which:
    * unparses + RE-PARSES (the parse-gate) — a tree that yields unparseable
      source is REJECTED and the file is left UNTOUCHED;
    * writes the file on success.

  Reifiability (the PLAN-018 constraint): the edit is expressed as DATA ops
  (q/apply-ops over an op-list), so a recorded edit is a value the reducer can
  compose — exercised here by composing two op-lists and proving equality.
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

  setup do
    dir = Path.join(System.tmp_dir!(), "code_edit_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, dir: dir}
  end

  defp run(prelude, program, binds) do
    {:ok, step} =
      PtcRunner.Lisp.run(program,
        prelude: prelude,
        context: binds,
        filter_context: false,
        caller: :in_process_v1
      )

    step.return
  end

  describe "code-edit — parse-gated transactional write" do
    test "a valid q/* edit applies and writes the file", %{prelude: prelude, dir: dir} do
      path = Path.join(dir, "a.ex")
      File.write!(path, "x + 1")

      tree = Code.parse_tool(%{"src" => "x + 1", "lang" => "elixir"})

      # rename identifier x -> y via q/apply-ops (the reifiable data path)
      edited =
        run(
          prelude,
          ~S"""
          (q/apply-ops data/tree
            [{"op" "update"
              "pattern" {"node" "identifier" "value" "x"}
              "template" {"node" "identifier" "value" "y"}}])
          """,
          %{"tree" => tree}
        )

      result = Code.edit_tool(%{"path" => path, "lang" => "elixir", "tree" => edited})

      assert %{"path" => ^path, "src" => src} = result
      refute Map.has_key?(result, "error")
      assert src =~ "y"
      refute src =~ "x"
      # the file on disk reflects the edit
      assert File.read!(path) == src
    end

    test "a bad edit (unparseable result) is REJECTED and the file is untouched",
         %{dir: dir} do
      path = Path.join(dir, "b.ex")
      original = "def f(x), do: x"
      File.write!(path, original)

      # Hand-build a broken tree: a raw leaf carrying garbage that cannot parse to
      # a clean tree. (Simulates an edit that produced invalid source.)
      broken = %{
        "node" => "source",
        "children" => [%{"node" => "token", "value" => "def def def )))("}]
      }

      result = Code.edit_tool(%{"path" => path, "lang" => "elixir", "tree" => broken})

      assert %{"error" => msg} = result
      assert msg =~ "parse-gate"
      # CRITICAL: the file is UNTOUCHED
      assert File.read!(path) == original
    end

    test "missing path / tree / lang is an error map", %{dir: dir} do
      tree = Code.parse_tool(%{"src" => "x", "lang" => "elixir"})
      assert %{"error" => m1} = Code.edit_tool(%{"lang" => "elixir", "tree" => tree})
      assert m1 =~ "path"

      assert %{"error" => m2} =
               Code.edit_tool(%{"path" => Path.join(dir, "x.ex"), "lang" => "elixir"})

      assert m2 =~ "tree"
    end
  end

  describe "reifiability — recorded data-ops compose (PLAN-018)" do
    test "applying concatenated op-lists equals applying them in sequence", %{prelude: prelude} do
      tree = Code.parse_tool(%{"src" => "a + b", "lang" => "elixir"})

      program = ~S"""
      (let [op (fn [from to] {"op" "update"
                              "pattern" {"node" "identifier" "value" from}
                              "template" {"node" "identifier" "value" to}})
            ops1 [(op "a" "c")]
            ops2 [(op "b" "d")]
            seq-applied (q/apply-ops (q/apply-ops data/tree ops1) ops2)
            concat-applied (q/apply-ops data/tree (concat ops1 ops2))]
        (q/equal? seq-applied concat-applied))
      """

      assert run(prelude, program, %{"tree" => tree}) == true
    end

    test "the edited tree from composed ops unparses to valid, gate-passing source",
         %{prelude: prelude} do
      tree = Code.parse_tool(%{"src" => "a + b", "lang" => "elixir"})

      edited =
        run(
          prelude,
          ~S"""
          (q/apply-ops data/tree
            [{"op" "update" "pattern" {"node" "identifier" "value" "a"}
              "template" {"node" "identifier" "value" "c"}}
             {"op" "update" "pattern" {"node" "identifier" "value" "b"}
              "template" {"node" "identifier" "value" "d"}}])
          """,
          %{"tree" => tree}
        )

      %{"src" => src} = Code.unparse_tool(%{"tree" => edited})
      # both renames landed and it is valid source
      assert src =~ "c"
      assert src =~ "d"
      reparsed = Code.parse_tool(%{"src" => src, "lang" => "elixir"})
      assert reparsed == Code.parse_tool(%{"src" => "c + d", "lang" => "elixir"})
    end
  end
end
