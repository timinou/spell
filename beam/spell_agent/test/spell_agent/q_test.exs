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

    # ── soundness regressions (W2 swarm review) ──
    test "SENTINEL-BLIND: a real tree shaped like a hole is data, not a pattern", %{
      prelude: prelude
    } do
      # A form_tree value that LOOKS like a node-hole must compare as DATA, and
      # equality must be SYMMETRIC. The old match-based equal? returned true one
      # way and false the other (it interpreted `a` as a pattern).
      hole_shaped = %{"node" => "~", "name" => "x"}
      lit = %{"node" => "literal", "value" => 1}

      assert q(prelude, ~S|(q/equal? data/a data/b)|, %{"a" => hole_shaped, "b" => lit}) == false
      assert q(prelude, ~S|(q/equal? data/b data/a)|, %{"a" => hole_shaped, "b" => lit}) == false
      # reflexive on the hole-shaped datum itself
      assert q(prelude, ~S|(q/equal? data/a data/a)|, %{"a" => hole_shaped}) == true
    end

    test "FULL KEY SET: a node with children is NOT equal to one without", %{prelude: prelude} do
      # The missing-children laxness of q/match must NOT leak into equality, or a
      # reducer could 'prove' dropping a command's args is sound.
      bare = %{"node" => "command", "name" => "rg"}

      with_args = %{
        "node" => "command",
        "name" => "rg",
        "children" => [%{"node" => "word", "value" => "-l"}]
      }

      assert q(prelude, ~S|(q/equal? data/a data/b)|, %{"a" => bare, "b" => with_args}) == false
      assert q(prelude, ~S|(q/equal? data/b data/a)|, %{"a" => bare, "b" => with_args}) == false
    end

    test "field-capture-shaped value compares as data, not as a capture", %{prelude: prelude} do
      # {"$" "v"} can be a legitimate literal value in a form_tree; equality must
      # not treat it as a field-capture.
      a = %{"node" => "literal", "value" => %{"$" => "v"}}
      b = %{"node" => "literal", "value" => %{"$" => "w"}}

      assert q(prelude, ~S|(q/equal? data/a data/a)|, %{"a" => a}) == true
      assert q(prelude, ~S|(q/equal? data/a data/b)|, %{"a" => a, "b" => b}) == false
    end
  end

  describe "the two reducer laws (PLAN-018) — proven via q/equal? on MULTI-node trees" do
    # A multi-node subject with an UNRELATED node bearing the rename's destination
    # name is the real proof: it catches the [x,y]->[z,z] clobber a single-node
    # subject hides. comp(x->y then y->z) must NOT touch a pre-existing y.
    test "composition does not clobber an unrelated destination node", %{prelude: prelude} do
      program = ~S"""
      (let [rn (fn [from to]
                 (fn [s] (q/update s {"node" "var" "name" from}
                                   (fn [_b _n] {"node" "var" "name" to}))))
            e1 (rn "x" "y")
            e2 (rn "y" "z")
            comp12 (fn [s] (e2 (e1 s)))
            direct (rn "x" "z")
            ;; subject has BOTH an x AND an unrelated y
            subj {"node" "seq" "children" [{"node" "var" "name" "x"} {"node" "var" "name" "y"}]}]
        ;; comp clobbers the unrelated y (x->y->z AND the original y->z): [z z].
        ;; direct leaves y alone: [z y]. So they are NOT equal — the law has a
        ;; PRECONDITION (no pre-existing destination), and this test pins that
        ;; composition is only sound under freshness.
        {"comp" (comp12 subj) "direct" (direct subj)
         "equal" (q/equal? (comp12 subj) (direct subj))})
      """

      r = q(prelude, program)
      # The honest result: they DIFFER (comp clobbered y). This documents the
      # freshness precondition rather than asserting a false identity.
      assert r["equal"] == false
      assert get_in(r, ["comp", "children", Access.at(1), "name"]) == "z"
      assert get_in(r, ["direct", "children", Access.at(1), "name"]) == "y"
    end

    test "composition IS identity-equal under freshness (no pre-existing dest)", %{
      prelude: prelude
    } do
      program = ~S"""
      (let [rn (fn [from to]
                 (fn [s] (q/update s {"node" "var" "name" from}
                                   (fn [_b _n] {"node" "var" "name" to}))))
            comp12 (fn [s] ((rn "y" "z") ((rn "x" "y") s)))
            direct (rn "x" "z")
            ;; only x and an unrelated w — no y, no z
            subj {"node" "seq" "children" [{"node" "var" "name" "x"} {"node" "var" "name" "w"}]}]
        (q/equal? (comp12 subj) (direct subj)))
      """

      assert q(prelude, program) == true
    end

    test "cancellation: edit ∘ inverse ≡ identity under freshness (multi-node)", %{
      prelude: prelude
    } do
      program = ~S"""
      (let [fwd (fn [s] (q/update s {"node" "var" "name" "a"}
                                  (fn [_b _n] {"node" "var" "name" "b"})))
            inv (fn [s] (q/update s {"node" "var" "name" "b"}
                                  (fn [_b _n] {"node" "var" "name" "a"})))
            ;; a + an unrelated c, NO pre-existing b — the freshness precondition
            subj {"node" "seq" "children" [{"node" "var" "name" "a"} {"node" "var" "name" "c"}]}]
        (q/equal? (inv (fwd subj)) subj))
      """

      assert q(prelude, program) == true
    end
  end

  describe "reifiable data-ops (q/apply-ops) — the PLAN-018 composable edit surface" do
    test "a data op-list is a value that rewrites a tree", %{prelude: prelude} do
      subj = %{
        "node" => "seq",
        "children" => [%{"node" => "var", "name" => "x"}, %{"node" => "var", "name" => "w"}]
      }

      # ops are DATA (no closure): [{op update pattern <x> template <z>}]
      program = ~S"""
      (q/apply-ops data/s
        [{"op" "update"
          "pattern" {"node" "var" "name" "x"}
          "template" {"node" "var" "name" "z"}}])
      """

      r = q(prelude, program, %{"s" => subj})
      assert get_in(r, ["children", Access.at(0), "name"]) == "z"
      assert get_in(r, ["children", Access.at(1), "name"]) == "w"
    end

    test "composing two data-op-lists equals applying their concatenation", %{prelude: prelude} do
      # The composability PLAN-018 needs: apply(ops1 ++ ops2) == apply(ops2) after
      # apply(ops1), with ops as pure data.
      program = ~S"""
      (let [op (fn [from to] {"op" "update"
                              "pattern" {"node" "var" "name" from}
                              "template" {"node" "var" "name" to}})
            subj {"node" "seq" "children" [{"node" "var" "name" "x"} {"node" "var" "name" "w"}]}
            ops1 [(op "x" "y")]
            ops2 [(op "w" "q")]
            seq-applied (q/apply-ops (q/apply-ops subj ops1) ops2)
            concat-applied (q/apply-ops subj (concat ops1 ops2))]
        (q/equal? seq-applied concat-applied))
      """

      assert q(prelude, program) == true
    end
  end

  describe "q/wrap — the original node is re-embedded" do
    test "wrap nests the matched node at the {~ _} hole", %{prelude: prelude} do
      subj = %{"node" => "call", "name" => "risky", "children" => []}

      # wrap risky in (try <orig> (rescue ...)) where {~ _} = the original call
      program = ~S"""
      (q/wrap data/s
        {"node" "call" "name" "risky" "children" []}
        {"node" "try" "children" [{"node" "~" "name" "_"}
                                  {"node" "rescue" "children" []}]})
      """

      r = q(prelude, program, %{"s" => subj})
      assert r["node"] == "try"
      # the FIRST child is the original risky call, not nil
      assert get_in(r, ["children", Access.at(0)]) == subj
      assert get_in(r, ["children", Access.at(1), "node"]) == "rescue"
    end
  end

  describe "field-role matching (W6 swarm review) — the code/parse `field` key" do
    test "a pattern with `field` matches ONLY the node in that role", %{prelude: prelude} do
      # mirror code/parse output: binary_operator with left/right operands tagged
      # by `field`, both identifiers named x.
      tree = %{
        "node" => "binary_operator",
        "children" => [
          %{"node" => "identifier", "value" => "x", "field" => "left"},
          %{"node" => "token", "value" => "+"},
          %{"node" => "identifier", "value" => "x", "field" => "right"}
        ]
      }

      # selecting field=left must match exactly ONE identifier, not both
      n =
        q(prelude, ~S|(count (q/descendant {"node" "identifier" "field" "left"} data/s))|, %{
          "s" => tree
        })

      assert n == 1
    end

    test "field capture {$ n} binds the role", %{prelude: prelude} do
      node = %{"node" => "identifier", "value" => "x", "field" => "left"}

      r =
        q(prelude, ~S|(q/match data/p data/s)|, %{
          "p" => %{"node" => "identifier", "field" => %{"$" => "role"}},
          "s" => node
        })

      assert r["role"] == "left"
    end
  end

  describe "apply-op error handling (W6 swarm review)" do
    test "an unknown op kind fails loud, not a silent no-op", %{prelude: prelude} do
      # A typo'd op kind must NOT silently return the subject unchanged (which
      # would pass code-edit's parse-gate and write an unmodified file). It must
      # surface a fail signal carrying the message.
      program = ~S"""
      (q/apply-ops {"node" "var" "name" "x"}
        [{"op" "udpate" "pattern" {"node" "var" "name" "x"}
          "template" {"node" "var" "name" "y"}}])
      """

      {:ok, step} = PtcRunner.Lisp.run(program, prelude: prelude, caller: :in_process_v1)
      # (fail ...) surfaces as a __ptc_fail__ value carrying the reason; the key
      # property is it is NOT the unchanged subject {"node" "var" "name" "x"}.
      assert match?({:__ptc_fail__, _}, step.return)
      {:__ptc_fail__, msg} = step.return
      assert msg =~ "unknown op kind"
    end
  end

  describe "matcher soundness regressions (W2 swarm review)" do
    test "absent subject field is a no-match, not a nil-bind", %{prelude: prelude} do
      # A pattern asking for "name" must NOT match a literal leaf that has no name.
      lit = %{"node" => "literal", "value" => 1}

      r =
        q(prelude, ~S|(q/matched? (q/match data/p data/s))|, %{
          "p" => %{"node" => "literal", "name" => %{"$" => "n"}},
          "s" => lit
        })

      assert r == false
    end

    test "a present nil field still matches (absence != nil)", %{prelude: prelude} do
      # If a subject explicitly carries value=nil and the pattern captures it, that
      # is a match binding nil — only ABSENCE is a no-match.
      node = %{"node" => "x", "value" => nil}

      r =
        q(prelude, ~S|(q/matched? (q/match data/p data/s))|, %{
          "p" => %{"node" => "x", "value" => %{"$" => "v"}},
          "s" => node
        })

      assert r == true
    end

    test "adjacent splices both bind [] on an empty child list", %{prelude: prelude} do
      # [~@a ~@b] against [] must succeed with a=[] b=[], not no-match.
      r =
        q(prelude, ~S|(q/match data/p data/s)|, %{
          "p" => %{
            "node" => "seq",
            "children" => [%{"node" => "~@", "name" => "a"}, %{"node" => "~@", "name" => "b"}]
          },
          "s" => %{"node" => "seq", "children" => []}
        })

      assert r == %{"a" => [], "b" => []}
    end

    test "trailing splice requires zero children (arity fix)", %{prelude: prelude} do
      # [~x ~@rest] against [one] must bind x=one, rest=[] — the old `count rest-pat`
      # bug made the trailing ~@ demand a child and no-matched.
      r =
        q(prelude, ~S|(q/match data/p data/s)|, %{
          "p" => %{
            "node" => "seq",
            "children" => [%{"node" => "~", "name" => "x"}, %{"node" => "~@", "name" => "rest"}]
          },
          "s" => %{"node" => "seq", "children" => [%{"node" => "word", "value" => "one"}]}
        })

      assert r["x"] == %{"node" => "word", "value" => "one"}
      assert r["rest"] == []
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
                (fn [_b _n] {"node" "var" "name" "y"}))
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
          %{
            "node" => "tool_call",
            "name" => "sh",
            "children" => [%{"node" => "literal", "value" => "a"}]
          },
          %{
            "node" => "let",
            "children" => [
              %{
                "node" => "tool_call",
                "name" => "sh",
                "children" => [%{"node" => "literal", "value" => "b"}]
              },
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

  describe "ergonomic sugar (FEAT-025) — desugars to canonical data" do
    test "q/id and q/tok build the literal node shapes", %{prelude: prelude} do
      assert q(prelude, ~S|(q/id "x")|) == %{"node" => "identifier", "value" => "x"}
      assert q(prelude, ~S|(q/tok "+")|) == %{"node" => "token", "value" => "+"}
    end

    test "q/rename-id is byte-identical to the hand-written update-op", %{prelude: prelude} do
      # This is the PLAN-018 reifiability guarantee: the sugar produces the SAME
      # plain data a recorded edit stores — not a closure, not a special form.
      hand = %{
        "op" => "update",
        "pattern" => %{"node" => "identifier", "value" => "x"},
        "template" => %{"node" => "identifier", "value" => "y"}
      }

      assert q(prelude, ~S|(q/rename-id "x" "y")|) == hand
    end

    test "rewrite-op / wrap-op carry the op kind + pattern/template through", %{prelude: prelude} do
      assert q(prelude, ~S|(q/rewrite-op {"node" "a"} {"node" "b"})|) == %{
               "op" => "rewrite",
               "pattern" => %{"node" => "a"},
               "template" => %{"node" => "b"}
             }

      assert q(prelude, ~S|(q/wrap-op {"node" "a"} {"node" "w"})|) == %{
               "op" => "wrap",
               "pattern" => %{"node" => "a"},
               "template" => %{"node" => "w"}
             }
    end

    test "sugar-built ops feed q/apply-ops and transform a real tree", %{prelude: prelude} do
      # (a + b) with a->c via the sugar op == via a hand op (end-to-end).
      tree = %{
        "node" => "source",
        "children" => [
          %{"node" => "identifier", "value" => "a"},
          %{"node" => "token", "value" => "+"},
          %{"node" => "identifier", "value" => "b"}
        ]
      }

      via_sugar = q(prelude, ~S|(q/apply-ops data/t [(q/rename-id "a" "c")])|, %{"t" => tree})

      via_hand =
        q(
          prelude,
          ~S|(q/apply-ops data/t [{"op" "update" "pattern" {"node" "identifier" "value" "a"} "template" {"node" "identifier" "value" "c"}}])|,
          %{"t" => tree}
        )

      assert q(prelude, ~S|(q/equal? data/a data/b)|, %{"a" => via_sugar, "b" => via_hand}) ==
               true
    end
  end
end
