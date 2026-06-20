# C11 FORM_TREE — the program as a WALKABLE TREE; structural self-queries (FUP-002).
#
# USE-CASE: MOVE-C put the executed CoreAST on every node. PTC has no tuple type,
# so Hist projects that AST into a PTC-NATIVE nested tree ("form_tree"). Now the
# agent can ask STRUCTURAL questions of its own past programs — "tool calls nested
# in a let", "defs whose value is a fn" — by walking data, WITHOUT an Elixir change
# per question. This is the PLAN-005 deferred form_tree power-lens, finally real:
# the AST *is* the tree.
#
# RUN:  mix run scripts/hist/c11_form_tree.exs

alias SpellAgent.Hist.{Lens, Namespace, Recorder, Store}
alias SpellAgent.Hist.Store.Memory

_ =
  case Memory.start_link([]) do
    {:ok, _} -> :ok
    {:error, {:already_started, _}} -> :ok
  end

Store.clear(Memory)

# Record turns with REAL CoreAST forms (parsed + analyzed via the genuine pipeline,
# exactly what MOVE-C puts on a live turn).
record = fn sid, src, parent ->
  {:ok, raw} = PtcRunner.Lisp.Parser.parse(src)
  {:ok, ast} = PtcRunner.Lisp.Analyze.analyze(raw)

  Recorder.record_node(
    Memory,
    sid,
    %{program: src, form: ast, memory: %{}, tool_calls: [], prints: [], raw_response: "r"},
    parent
  )
end

IO.puts("\n== a session of structurally-varied programs ==")
a = record.("s", "(let [r (tool/bar {})] r)", nil)
b = record.("s", "(def f (fn [x] (tool/foo x)))", a.id)
c = record.("s", "(tool/top {})", b.id)
IO.puts("  turn 1: (let [r (tool/bar {})] r)        — tool call INSIDE a let")
IO.puts("  turn 2: (def f (fn [x] (tool/foo x)))    — a def whose value is a fn")
IO.puts("  turn 3: (tool/top {})                    — a top-level tool call")

IO.puts("\n== (1) the program is projected to a PTC-native tree (no tuples) ==")

tree =
  Lens.form_tree(
    elem(
      PtcRunner.Lisp.Analyze.analyze(
        elem(PtcRunner.Lisp.Parser.parse("(def f (fn [x] (tool/foo x)))"), 1)
      ),
      1
    )
  )

IO.puts("  form_tree of turn 2 -> node=#{tree["node"]} name=#{tree["name"]}")
IO.puts("    children kinds: #{inspect(Enum.map(tree["children"], & &1["node"]))}")

has_tuple = fn
  f, t when is_tuple(t) -> true
  f, t when is_map(t) -> Enum.any?(t, fn {k, v} -> f.(f, k) or f.(f, v) end)
  f, t when is_list(t) -> Enum.any?(t, &f.(f, &1))
  _f, _ -> false
end

false = has_tuple.(has_tuple, tree)
IO.puts("  PROOF: the tree is tuple-free — safe to hand a sandboxed PTC lens OK")

verbs = Namespace.tools(Memory, "s")

IO.puts("\n== (2) STRUCTURAL query: tool calls nested INSIDE a let ==")
in_let = verbs["hist/form_tree"].(%{"within" => "let", "find" => "tool_call"})

IO.puts(
  "  (hist/form_tree {:within \"let\" :find \"tool_call\"}) -> #{inspect(Enum.map(in_let, & &1["name"]))}"
)

true = Enum.map(in_let, & &1["name"]) == ["bar"]
IO.puts("  PROOF: only `bar` (in the let); `top` is top-level so excluded OK")

IO.puts("\n== (3) STRUCTURAL query: defs whose value is a fn ==")
fn_defs = verbs["hist/form_tree"].(%{"within" => "def", "find" => "fn"})

IO.puts(
  "  (hist/form_tree {:within \"def\" :find \"fn\"}) -> #{length(fn_defs)} hit(s) at turn(s) #{inspect(Enum.map(fn_defs, & &1["seq"]))}"
)

true = Enum.any?(fn_defs, &(&1["node_id"] == b.id))
IO.puts("  PROOF: turn 2's (def f (fn ...)) matched OK")

IO.puts("\n== (4) whole-tree query: EVERY tool call in the session ==")
all = verbs["hist/form_tree"].(%{"find" => "tool_call"}) |> Enum.map(& &1["name"]) |> Enum.sort()
IO.puts("  (hist/form_tree {:find \"tool_call\"}) -> #{inspect(all)}")
true = all == ["bar", "foo", "top"]
IO.puts("  PROOF: bar + foo + top, found by walking the tree as DATA OK")

IO.puts("\n== (5) the agent can AUTHOR a novel structural lens at runtime ==")
# "node ids whose program contains a fn anywhere" — not a built-in; pure tree walk.
authored =
  ~S|(let [flatten (fn flatten [t] (if (map? t) (cons t (mapcat flatten (get t "children"))) []))]
  (->> data/nodes
       (filter (fn [n] (some (fn [x] (= (get x "node") "fn")) (flatten (get n "form_tree")))))
       (map (fn [n] (get n "id")))))|

authored_hits = verbs["hist/lens"].(%{"source" => authored})
IO.puts("  agent-authored \"programs containing a fn\" -> #{inspect(authored_hits)}")
true = authored_hits == [b.id]
IO.puts("  PROOF: the novel structural lens found turn 2, zero Elixir deploy OK")

IO.puts(
  "\nC11 FORM_TREE: the program is data the agent walks. Structural self-query, homoiconic.\n"
)
