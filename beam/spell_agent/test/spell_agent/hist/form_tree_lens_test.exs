defmodule SpellAgent.Hist.FormTreeLensTest do
  @moduledoc """
  FUP-002 — the form_tree structural lens: the executed CoreAST (MOVE-C) projected
  to a PTC-NATIVE tree so a sandboxed lens can ask structural questions of past
  programs ("tool calls nested inside a let", "defs whose value is a fn") with no
  Elixir change per question. Subsumes the PLAN-005 deferred form_tree (the AST
  *is* the tree).

  Cassette-backed: programs are recorded with real CoreAST forms, persisted to a
  fixture, and replayed (`SpellAgent.HistCassette`) so the structural assertions
  run against serialized-and-reloaded history.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Lens, Namespace}
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.HistCassette

  @store Memory

  # Real CoreAST shapes (what MOVE-C puts on turn.form / Node.form):
  #   (let [r (tool/bar {})] r)
  defp let_with_tool do
    {:let, [{"r", {:tool_call, "bar", [{:literal, %{}}]}}], [{:var, "r"}]}
  end

  #   (def f (fn [x] (tool/foo x)))   — a def whose value is a fn that calls a tool
  defp def_of_fn do
    {:def, "f", {:fn, [{:var, "x"}], [{:tool_call, "foo", [{:var, "x"}]}]}, %{}}
  end

  #   (tool/top {})  — a top-level tool call, NOT inside a let
  defp top_tool, do: {:tool_call, "top", [{:literal, %{}}]}

  defp turn(program, form) do
    %{program: program, form: form, memory: %{}, tool_calls: [], prints: [], raw_response: "r"}
  end

  defp cassette_turns do
    [
      turn("(let [r (tool/bar {})] r)", let_with_tool()),
      turn("(def f (fn [x] (tool/foo x)))", def_of_fn()),
      turn("(tool/top {})", top_tool())
    ]
  end

  setup do
    %{nodes: nodes} = HistCassette.ensure("form_tree_basic", "ft", cassette_turns(), @store)
    {:ok, nodes: nodes, verbs: Namespace.tools(@store, "ft")}
  end

  test "form_tree/1 projects a def-of-fn to a nested PTC-native tree" do
    tree = Lens.form_tree(def_of_fn())

    assert tree["node"] == "def"
    assert tree["name"] == "f"
    [fn_node] = tree["children"]
    assert fn_node["node"] == "fn"
    # the tool call lives somewhere under the fn body
    assert find_kind(fn_node, "tool_call")["name"] == "foo"
  end

  test "PTC-SAFETY: the projected tree contains NO tuples (sandbox value model)" do
    for form <- [let_with_tool(), def_of_fn(), top_tool()] do
      tree = Lens.form_tree(form)
      refute has_tuple?(tree), "form_tree output must be tuple-free for #{inspect(form)}"
    end
  end

  test "a non-AST form (synthetic string / nil) projects to nil" do
    assert Lens.form_tree("(def x 1)") == nil
    assert Lens.form_tree(nil) == nil
  end

  test "unknown/future AST kinds still project (drift-resilient), never crash" do
    # A kind this projector has no explicit clause for.
    tree = Lens.form_tree({:some_future_node, {:var, "a"}, {:literal, 7}})
    assert tree["node"] == "some_future_node"
    assert length(tree["children"]) == 2
    assert Enum.any?(tree["children"], &(&1["node"] == "var"))
  end

  test "the projection exposes form_tree per node for lens authoring", %{} do
    [p1, _p2, _p3] = Lens.project(@store, "ft")
    assert p1["form_tree"]["node"] == "let"
    refute has_tuple?(p1["form_tree"])
  end

  test "hist/form_tree finds tool calls nested inside a let", %{
    verbs: verbs,
    nodes: [n1, _n2, _n3]
  } do
    hits = verbs["hist/form_tree"].(%{"within" => "let", "find" => "tool_call"})

    names = Enum.map(hits, & &1["name"])
    assert "bar" in names
    # the top-level (tool/top) is NOT inside a let, so excluded
    refute "top" in names
    # the hit is attributed to the let turn
    assert Enum.any?(hits, &(&1["node_id"] == n1.id and &1["name"] == "bar"))
  end

  test "hist/form_tree with no :within searches the whole tree", %{verbs: verbs} do
    hits = verbs["hist/form_tree"].(%{"find" => "tool_call"})
    names = hits |> Enum.map(& &1["name"]) |> Enum.sort()
    # every tool call across the session: bar (in let), foo (in fn), top (top-level)
    assert names == ["bar", "foo", "top"]
  end

  test "hist/form_tree finds a fn nested in a def (defs whose value is a fn)", %{
    verbs: verbs,
    nodes: [_n1, n2, _n3]
  } do
    hits = verbs["hist/form_tree"].(%{"within" => "def", "find" => "fn"})
    assert Enum.any?(hits, &(&1["node_id"] == n2.id))
  end

  test "END-TO-END: a REAL parsed+analyzed program projects + structurally queries" do
    # Use the genuine PtcRunner pipeline so the test tracks the ACTUAL AST shape
    # (e.g. :let bindings wrap in {:binding, ...}, :fn params are a keyword list),
    # not a hand-built guess. This is the contract that matters in production.
    {:ok, raw} = PtcRunner.Lisp.Parser.parse("(let [r (tool/bar {})] r)")
    {:ok, real_ast} = PtcRunner.Lisp.Analyze.analyze(raw)

    tree = Lens.form_tree(real_ast)
    assert tree["node"] == "let"
    refute has_tuple?(tree)
    # the tool call is reachable somewhere in the real let's subtree
    assert find_kind(tree, "tool_call")["name"] == "bar"

    # and it flows through a recorded node + the structural lens end to end
    real_turn = %{
      program: "(let [r (tool/bar {})] r)",
      form: real_ast,
      memory: %{},
      tool_calls: [],
      prints: [],
      raw_response: "r"
    }

    SpellAgent.Hist.Recorder.record_node(@store, "e2e", real_turn, nil)

    hits =
      Namespace.tools(@store, "e2e")["hist/form_tree"].(%{
        "within" => "let",
        "find" => "tool_call"
      })

    assert Enum.any?(hits, &(&1["name"] == "bar"))
  end

  # --- helpers ---

  defp find_kind(tree, kind) when is_map(tree) do
    if tree["node"] == kind do
      tree
    else
      tree |> Map.get("children", []) |> Enum.find_value(fn c -> find_kind(c, kind) end)
    end
  end

  defp find_kind(_, _), do: nil

  defp has_tuple?(t) when is_tuple(t), do: true

  defp has_tuple?(t) when is_map(t),
    do: Enum.any?(t, fn {k, v} -> has_tuple?(k) or has_tuple?(v) end)

  defp has_tuple?(t) when is_list(t), do: Enum.any?(t, &has_tuple?/1)
  defp has_tuple?(_), do: false
end
