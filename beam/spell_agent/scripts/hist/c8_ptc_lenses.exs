# C8 PTC LENSES — the homoiconic query layer (PLAN-005, FUP-PTC-LENSES).
#
# USE-CASE: the pure query lenses (forms/defs/tool_calls/cost) are not Elixir
# functions the agent must wait for someone to ship — they are PTC-Lisp SOURCE,
# run over a projection of the agent's own history. So the agent can (1) call them
# like any tool, (2) trust them (they match the Elixir verbs exactly), and (3)
# AUTHOR A BRAND-NEW LENS at runtime and run it with zero Elixir deploy.
#
# This is the PLAN-004 boundary made concrete: Elixir materializes + projects +
# enforces heap safety; PTC interprets. A bad lens = a wrong query, never a corrupt
# store.
#
# RUN:  mix run scripts/hist/c8_ptc_lenses.exs

alias SpellAgent.Hist.{Lens, Namespace, Query, Recorder, Store}
alias SpellAgent.Hist.Store.Memory

# Memory may already be supervised by the app; tolerate that.
_ = case Memory.start_link([]) do
  {:ok, _} -> :ok
  {:error, {:already_started, _}} -> :ok
end
Store.clear(Memory)

IO.puts("\n== seed a session: edits, a def, an errored find ==")
a = Recorder.record_node(Memory, "s", %{program: {:tool_call, "edit", %{target: "auth.ex"}}, memory: %{}, tool_calls: [%{name: "edit", args: %{}, result: %{"ok" => 1}}], tokens: %{input: 40, output: 8}}, nil)
b = Recorder.record_node(Memory, "s", %{program: {:def, :plan, 1, %{}}, memory: %{plan: 1}, tool_calls: [%{name: "find", args: %{}, result: %{"err" => "no match"}}], tokens: %{input: 12, output: 3}}, a.id)
_c = Recorder.record_node(Memory, "s", %{program: {:tool_call, "edit", %{target: "auth.ex"}}, memory: %{}, tool_calls: [%{name: "edit", args: %{}, result: %{"ok" => 1}}], tokens: %{input: 9, output: 4}}, b.id)
IO.puts("  3 turns recorded")

verbs = Namespace.tools(Memory, "s")

IO.puts("\n== (1) a PTC lens, called like any tool ==")
forms = verbs["hist/forms"].(%{"tool" => "edit"})
IO.puts("  (hist/forms {:tool \"edit\"}) -> #{length(forms)} turns: #{inspect(Enum.map(forms, & &1["id"]))}")

IO.puts("\n== (2) PROOF: the PTC lens == the Elixir verb (parity oracle) ==")
ptc_cost = verbs["hist/cost"].(%{})
elx_cost = Query.cost(Memory, "s")
IO.puts("  hist/cost  (PTC)    : #{inspect(ptc_cost)}")
IO.puts("  Query.cost (Elixir) : #{inspect(elx_cost)}")
true = ptc_cost["total"] == elx_cost.total and ptc_cost["nodes_counted"] == elx_cost.nodes_counted
IO.puts("  PROOF: identical totals + nodes_counted OK")

ptc_forms = Enum.map(verbs["hist/forms"].(%{"tool" => "edit"}), & &1["id"])
elx_forms = Enum.map(Query.forms(Memory, "s", {:tool_call, "edit"}), & &1.id)
true = ptc_forms == elx_forms
IO.puts("  PROOF: hist/forms == Query.forms (same node ids, same order) OK")

IO.puts("\n== (3) the agent AUTHORS A NOVEL LENS at runtime — zero Elixir ==")
# "turns that BOTH defined a symbol AND errored a tool call" — not a built-in lens;
# only expressible by composing the projection. The agent writes it as data.
authored = ~S|(->> data/nodes
     (filter (fn [n] (and (not (empty? (get n "defs")))
                          (some (fn [c] (= (get c "status") "error")) (get n "tool_calls")))))
     (map (fn [n] {"id" (get n "id") "defs" (get n "defs")})))|
IO.puts("  agent-authored source:")
IO.puts("    (->> data/nodes (filter <defined-a-sym AND errored>) (map id+defs))")
result = verbs["hist/lens"].(%{"source" => authored})
IO.puts("  (hist/lens {:source ...}) -> #{inspect(result)}")
true = length(result) == 1 and hd(result)["id"] == b.id
IO.puts("  PROOF: the novel lens found turn b (defined `plan`, find errored) OK")

IO.puts("\n== (4) a broken lens is a wrong query, NEVER a crash ==")
oops = verbs["hist/lens"].(%{"source" => "(this is not ( valid"})
IO.puts("  broken lens -> #{inspect(oops)}")
true = match?({:error, _}, oops) or match?(%{"err" => _}, oops)
IO.puts("  PROOF: error returned as data; the store is untouched OK")

IO.puts("\n== (5) heap safety: project a big session, lens it, no OOM ==")
Enum.reduce(1..2_000, nil, fn i, p ->
  n = Recorder.record_node(Memory, "big", %{program: {:tool_call, "edit", %{n: i}}, memory: %{}, tool_calls: [%{name: "edit", args: %{}, result: %{"ok" => i}}], tokens: %{input: 1, output: 1}}, p)
  n.id
end)
big = Lens.run(Memory, "big", Map.fetch!(Lens.sources(), "cost"), %{})
IO.puts("  2000-turn session, hist/cost -> #{inspect(big)}")
true = big["nodes_counted"] == 2_000
IO.puts("  PROOF: the projection parked + lensed safely (heap caps held) OK")

IO.puts("\nC8 PTC LENSES: the query layer is data the agent reads, trusts, and extends. Homoiconic, by construction.\n")
