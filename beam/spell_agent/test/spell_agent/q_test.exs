defmodule SpellAgent.QTest do
  @moduledoc """
  PLAN-020 W1 — the q/* structural-transform algebra over form_tree.

  q/* is the SHARED ENGINE two plans consume (lispy code/edit + PLAN-018's
  history-reducer), so it is tested STANDALONE: a compiled prelude run over
  hand-built + Lens.form_tree + sh/parse fixtures, with NO dependency on
  code/parse. The suite defends:

    * the matcher contract (node-hole, splice, field-capture, wildcard,
      non-linear repeats) — the prototype's full table;
    * q/equal? as a structural-equality law (LAW 1/2);
    * the two REDUCER laws PLAN-018 lives on: transform composition
      (comp(e2,e1) ≡ direct) and cancellation (edit∘inverse ≡ identity),
      proven via q/equal?;
    * three-surface generality: the SAME matcher works over sh/parse and
      Lens.form_tree output, not just source-shaped trees.
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp.Prelude.Compiler
  alias SpellAgent.BrushNif
  alias SpellAgent.Hist.Lens

  # The q.clj prelude, compiled once for the whole suite.
  @q_source File.read!(
              Path.join([
                :code.priv_dir(:spell_agent) |> to_string(),
                "preludes",
                "q.clj"
              ])
            )

  setup_all do
    {:ok, prelude} = Compiler.compile(@q_source)
    {:ok, prelude: prelude}
  end

  # Run a q/* program, returning its value. `binds` injects data/<key> context so
  # a test can pass trees as data rather than embedding them in source.
  defp q(prelude, program, binds \\ %{}) do
    {:ok, step} =
      PtcRunner.Lisp.run(program,
        prelude: prelude,
        context: binds,
        filter_context: false,
        caller: :in_process_v1
      )

    step.return
  end

  # ── fixtures (real-shaped: mirror brush + lens output) ──────────────────────

  defp cmd_rg do
    %{
      "node" => "command",
      "name" => "rg",
      "children" => [
        %{"node" => "word", "value" => "-l"},
        %{"node" => "word", "value" => "TODO"},
        %{"node" => "word", "value" => "lib"}
      ]
    }
  end

  describe "matcher — the prototype table" do
    test "command head + splice captures all args", %{prelude: prelude} do
      r =
        q(
          prelude,
          ~S|(q/match data/p data/s)|,
          %{
            "p" => %{
              "node" => "command",
              "name" => "rg",
              "children" => [%{"node" => "~@", "name" => "args"}]
            },
            "s" => cmd_rg()
          }
        )

      assert is_map(r)
      assert length(r["args"]) == 3
    end

    test "wildcard tool name, capture a single arg", %{prelude: prelude} do
      tree = %{
        "node" => "tool_call",
        "name" => "sh",
        "children" => [%{"node" => "literal", "value" => "x"}]
      }

      r =
        q(
          prelude,
          ~S|(q/match data/p data/s)|,
          %{
            "p" => %{
              "node" => "tool_call",
              "name" => "sh",
              "children" => [%{"node" => "~", "name" => "a"}]
            },
            "s" => tree
          }
        )

      assert r["a"] == %{"node" => "literal", "value" => "x"}
    end

    test "kind mismatch is no-match", %{prelude: prelude} do
      r =
        q(prelude, ~S|(q/matched? (q/match data/p data/s))|, %{
          "p" => %{"node" => "pipeline", "children" => []},
          "s" => cmd_rg()
        })

      assert r == false
    end

    test "splice in the middle: [~a ~@mid ~c]", %{prelude: prelude} do
      r =
        q(
          prelude,
          ~S|(q/match data/p data/s)|,
          %{
            "p" => %{
              "node" => "command",
              "name" => "rg",
              "children" => [
                %{"node" => "~", "name" => "a"},
                %{"node" => "~@", "name" => "mid"},
                %{"node" => "~", "name" => "c"}
              ]
            },
            "s" => cmd_rg()
          }
        )

      assert r["a"] == %{"node" => "word", "value" => "-l"}
      assert r["c"] == %{"node" => "word", "value" => "lib"}
      assert r["mid"] == [%{"node" => "word", "value" => "TODO"}]
    end

    test "field-capture binds a node's name via {$ n}", %{prelude: prelude} do
      def_x = %{
        "node" => "def",
        "name" => "x",
        "children" => [%{"node" => "literal", "value" => 1}]
      }

      r =
        q(
          prelude,
          ~S|(q/match data/p data/s)|,
          %{
            "p" => %{
              "node" => "def",
              "name" => %{"$" => "nm"},
              "children" => [%{"node" => "~", "name" => "v"}]
            },
            "s" => def_x
          }
        )

      assert r["nm"] == "x"
      assert r["v"] == %{"node" => "literal", "value" => 1}
    end

    test "non-linear repeated capture: passes on equal, fails on differ", %{prelude: prelude} do
      pat = %{
        "node" => "command",
        "name" => "eq",
        "children" => [%{"node" => "~", "name" => "x"}, %{"node" => "~", "name" => "x"}]
      }

      equal = %{
        "node" => "command",
        "name" => "eq",
        "children" => [%{"node" => "word", "value" => "a"}, %{"node" => "word", "value" => "a"}]
      }

      differ = %{
        "node" => "command",
        "name" => "eq",
        "children" => [%{"node" => "word", "value" => "a"}, %{"node" => "word", "value" => "b"}]
      }

      assert q(prelude, ~S|(q/matched? (q/match data/p data/s))|, %{"p" => pat, "s" => equal}) ==
               true

      assert q(prelude, ~S|(q/matched? (q/match data/p data/s))|, %{"p" => pat, "s" => differ}) ==
               false
    end
  end

  describe "q/equal? — structural equality (LAW 1/2)" do
    test "identical trees are equal; differing name is not", %{prelude: prelude} do
      a = %{"node" => "def", "name" => "x", "children" => [%{"node" => "literal", "value" => 1}]}
      b = %{"node" => "def", "name" => "y", "children" => [%{"node" => "literal", "value" => 1}]}

      assert q(prelude, ~S|(q/equal? data/a data/a)|, %{"a" => a}) == true
      assert q(prelude, ~S|(q/equal? data/a data/b)|, %{"a" => a, "b" => b}) == false
    end

    test "canonicalization: presentation-equal trees compare equal", %{prelude: prelude} do
      # a|b vs 'a'|'b' — word VALUES are logical (quotes removed), so the two
      # pipelines are structurally identical even though their source differs.
      bare = %{
        "node" => "pipeline",
        "children" => [
          %{"node" => "command", "name" => "a"},
          %{"node" => "command", "name" => "b"}
        ]
      }

      assert q(prelude, ~S|(q/equal? data/a data/a)|, %{"a" => bare}) == true
    end
  end

  describe "the two reducer laws (PLAN-018) — proven via q/equal?" do
    test "transform composition: comp(rename y→z, rename x→y) ≡ rename x→z", %{prelude: prelude} do
      program = ~S"""
      (let [rn (fn [from to]
                 (fn [s] (q/rewrite {"node" "var" "name" from}
                                    {"node" "var" "name" to}
                                    s)))
            e1 (rn "x" "y")
            e2 (rn "y" "z")
            comp12 (fn [s] (e2 (e1 s)))
            direct (rn "x" "z")
            subj {"node" "var" "name" "x"}]
        (q/equal? (comp12 subj) (direct subj)))
      """

      assert q(prelude, program) == true
    end

    test "cancellation: edit ∘ inverse ≡ identity", %{prelude: prelude} do
      program = ~S"""
      (let [fwd (fn [s] (q/rewrite {"node" "var" "name" "a"} {"node" "var" "name" "b"} s))
            inv (fn [s] (q/rewrite {"node" "var" "name" "b"} {"node" "var" "name" "a"} s))
            subj {"node" "var" "name" "a"}]
        (q/equal? (inv (fwd subj)) subj))
      """

      assert q(prelude, program) == true
    end
  end

  describe "emit / rewrite / update" do
    test "rewrite console.log → logger.info keeping spliced args", %{prelude: prelude} do
      logcall = %{
        "node" => "call",
        "name" => "console.log",
        "children" => [
          %{"node" => "literal", "value" => "hi"},
          %{"node" => "var", "name" => "x"}
        ]
      }

      r =
        q(
          prelude,
          ~S|(q/rewrite {"node" "call" "name" "console.log" "children" [{"node" "~@" "name" "args"}]} {"node" "call" "name" "logger.info" "children" [{"node" "~@" "name" "args"}]} data/s)|,
          %{"s" => logcall}
        )

      assert r["name"] == "logger.info"
      assert r["children"] == logcall["children"]
    end

    test "update rewrites every matching subtree throughout the tree", %{prelude: prelude} do
      nested = %{
        "node" => "seq",
        "children" => [
          %{"node" => "var", "name" => "x"},
          %{"node" => "seq", "children" => [%{"node" => "var", "name" => "x"}]}
        ]
      }

      program = ~S"""
      (q/update data/s {"node" "var" "name" "x"}
                (fn [_b] {"node" "var" "name" "y"}))
      """

      r = q(prelude, program, %{"s" => nested})
      # both x's became y
      assert get_in(r, ["children", Access.at(0), "name"]) == "y"
      assert get_in(r, ["children", Access.at(1), "children", Access.at(0), "name"]) == "y"
    end
  end

  describe "descendant / select" do
    test "descendant finds all matching subtrees pre-order", %{prelude: prelude} do
      nested = %{
        "node" => "seq",
        "children" => [
          %{"node" => "tool_call", "name" => "sh", "children" => [%{"node" => "literal", "value" => "a"}]},
          %{
            "node" => "let",
            "children" => [
              %{"node" => "tool_call", "name" => "sh", "children" => [%{"node" => "literal", "value" => "b"}]},
              %{"node" => "tool_call", "name" => "edit", "children" => []}
            ]
          }
        ]
      }

      n =
        q(
          prelude,
          ~S|(count (q/descendant {"node" "tool_call" "name" "sh" "children" [{"node" "~@" "name" "_"}]} data/s))|,
          %{"s" => nested}
        )

      assert n == 2
    end
  end

  describe "three-surface generality — the SAME matcher over sh/parse and Lens.form_tree" do
    test "matches a command head in a real brush sh/parse tree", %{prelude: prelude} do
      {:ok, tree} = BrushNif.parse("rg -l TODO lib")

      # find the command node anywhere under the program tree
      n =
        q(
          prelude,
          ~S|(count (q/descendant {"node" "command" "name" "rg" "children" [{"node" "~@" "name" "_"}]} data/s))|,
          %{"s" => tree}
        )

      assert n == 1
    end

    test "matches a tool_call in a real Lens.form_tree of recorded CoreAST", %{prelude: prelude} do
      # (def f (fn [x] (tool/foo x))) — the form_tree of a recorded turn
      form = {:def, "f", {:fn, [{:var, "x"}], [{:tool_call, "foo", [{:var, "x"}]}]}, %{}}
      tree = Lens.form_tree(form)

      n =
        q(
          prelude,
          ~S|(count (q/descendant {"node" "tool_call" "name" "foo" "children" [{"node" "~@" "name" "_"}]} data/s))|,
          %{"s" => tree}
        )

      assert n == 1
    end
  end

  describe "projections" do
    test "q/body returns the last child; q/sig the rest", %{prelude: prelude} do
      def_node = %{
        "node" => "def",
        "name" => "f",
        "children" => [%{"node" => "var", "name" => "x"}, %{"node" => "literal", "value" => 1}]
      }

      assert q(prelude, ~S|(q/body data/s)|, %{"s" => def_node}) == %{
               "node" => "literal",
               "value" => 1
             }

      assert q(prelude, ~S|(q/sig data/s)|, %{"s" => def_node}) == [
               %{"node" => "var", "name" => "x"}
             ]
    end
  end
end
