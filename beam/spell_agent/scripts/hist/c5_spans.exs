# C5 SPANS — execution interior + cost (PLAN-001).
#
# USE-CASE: the agent wants to explain what happened inside a previous turn.
# The turn's `span_root` preserves a snapshot of the live telemetry subtree:
# a run containing a tool call and an LLM call, with token tallies on each.
# This script flattens the subtree, sums token cost, and traces every `find`
# tool span across the session.
#
# RUN:  mix run scripts/hist/c5_spans.exs

alias SpellAgent.Hist.{Recorder, Spans}
alias SpellAgent.Hist.Store
alias SpellAgent.Hist.Store.Memory

# Memory may already be supervised by the app; tolerate that.
_ = case Memory.start_link([]) do
  {:ok, _} -> :ok
  {:error, {:already_started, _}} -> :ok
end
Store.clear(Memory)

IO.puts("\n== SESSION: one turn with nested execution interior ==")

span_root = %{
  id: "run-1",
  kind: :run,
  label: "run  planner",
  children: [
    %{
      id: "tool-find-1",
      kind: :tool,
      name: "find",
      label: "tool  find",
      tokens: %{input: 10, output: 5},
      children: [],
      meta: %{tool_name: "find"}
    },
    %{
      id: "llm-1",
      kind: :llm,
      label: "llm  120→30 tok",
      tokens: %{input: 120, output: 30},
      children: []
    }
  ],
  tokens: %{input: 1, output: 0}
}

turn =
  Recorder.record_node(Memory, "session-S",
    %{
      program: "(tool/find {:target \"lib/auth.ex\"})",
      memory: %{},
      result: %{ok: true},
      span_root: span_root,
      tokens: %{input: 1, output: 0}
    }, nil)

IO.puts("  recorded turn #{turn.seq}")

IO.puts("\n== SPANS: flattened subtree ==")
flat = Spans.spans(turn)
for s <- flat do
  kind = s[:kind] || s["kind"]
  id = s[:id] || s["id"]
  IO.puts("  - #{kind}  #{id}")
end

IO.puts("\n== COST: tokens summed across the subtree ==")
cost = Spans.cost(turn)
IO.puts("  input:  #{cost.input}")
IO.puts("  output: #{cost.output}")

IO.puts("\n== TRACE: every `find` tool span in the session ==")
[h | _] = Spans.trace(Memory, "session-S", "find")
IO.puts("  found #{h[:id]} in node #{h.node_id} (seq #{h.node_seq})")

# PROOFS
3 = length(flat)
IO.puts("\n  PROOF: subtree flattens to 3 spans OK")

true = cost.input == 131 and cost.output == 35
IO.puts("  PROOF: cost sums to 131 input + 35 output tokens OK")

true = h[:id] == "tool-find-1"
IO.puts("  PROOF: trace locates the `find` tool span OK")

IO.puts("\nC5 SPANS: the agent inspected execution interior and cost without re-running.\n")
