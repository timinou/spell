# C3 TOOLS — promote a session-authored tool to durable storage (PLAN-001).
#
# USE-CASE: in session A the agent authors `blast-radius`. We promote it via
# `promote_from/3` (no live ToolRegistry required). The tool is now durable and
# survives into session B.
#
# RUN:  mix run scripts/hist/c3_tools.exs

alias SpellAgent.Hist.{Recorder, Tools}
alias SpellAgent.Hist.Store
alias SpellAgent.Hist.Store.Memory

# Memory may already be supervised by the app; tolerate that.
_ = case Memory.start_link([]) do
  {:ok, _} -> :ok
  {:error, {:already_started, _}} -> :ok
end
Store.clear(Memory)

IO.puts("\n== SESSION A: agent authors blast-radius ==")

n1 =
  Recorder.record_node(Memory, "session-A", %{
    program: ~S|(tool/define-tool {:name "blast-radius" :source "(...)"})|,
    memory: %{},
    result: "authored blast-radius",
    tool_calls: [
      %{name: "define-tool", args: %{name: "blast-radius"}},
      %{name: "blast-radius", args: %{sym: "foo"}, result: %{hits: [1, 2]}},
      %{name: "blast-radius", args: %{sym: "bar"}, result: {:error, :timeout}}
    ]
  }, nil)

IO.puts("  authored node: #{n1.id}")

IO.puts("\n== PROMOTE: make the tool durable ==")

tool =
  Tools.promote_from(Memory, %{
    name: "blast-radius",
    source: ~S|(tool/find {:target (str data/sym " def->")})|,
    params: [:sym],
    doc: "Find callers of a symbol.",
    session: "session-A",
    node_id: n1.id
  })

IO.puts("  promoted: #{tool.name} scope=#{tool.scope}")

# PROOFS
[%SpellAgent.Hist.ToolDef{name: "blast-radius"}] = Tools.durable(Memory)
IO.puts("  PROOF durable: tool is listed as durable OK")

[entry] = Tools.inventory(Memory, "session-A")
true = entry.name == "blast-radius"
true = entry.calls == 2
true = entry.errors == 1
true = entry.defined_node == n1.id
IO.puts("  PROOF inventory: calls=#{entry.calls} errors=#{entry.errors} defined_node=#{entry.defined_node} OK")

:ok = Tools.prune(Memory, "blast-radius")
true = Tools.durable(Memory) == []
IO.puts("  PROOF prune: durable list is empty after prune OK")

IO.puts("\nC3 TOOLS: session-authored tool became durable memory.\n")
