# C4 QUERY — the agent interrogates its own past in PTC-Lisp (PLAN-001).
#
# USE-CASE: after a messy debugging run, the agent wants to know "which
# `(tool/edit ...)` calls did I run that errored?" It queries the durable
# history directly: no LLM, no re-execution. The answer comes back as plain
# data listing the offending tool calls plus every turn whose program contained
# an edit tool invocation.
#
# RUN:  mix run scripts/hist/c4_query.exs

alias SpellAgent.Hist.{Query, Recorder}
alias SpellAgent.Hist.Store
alias SpellAgent.Hist.Store.Memory

# Memory may already be supervised by the app; tolerate that.
_ = case Memory.start_link([]) do
  {:ok, _} -> :ok
  {:error, {:already_started, _}} -> :ok
end
Store.clear(Memory)

IO.puts("\n== SESSION: agent works, one edit fails ==")

find_turn =
  Recorder.record_node(Memory, "session-Q",
    %{
      program: {:tool_call, "find", %{target: "lib/auth.ex"}},
      memory: %{},
      result: %{ok: true},
      tool_calls: [
        %{name: "find", args: %{target: "lib/auth.ex"}, result: %{ok: true}}
      ]
    }, nil)

IO.puts("  turn #{find_turn.seq}: (tool/find ...) -> ok")

edit_turn =
  Recorder.record_node(Memory, "session-Q",
    %{
      program: {:tool_call, "edit", %{target: "lib/auth.ex", content: "..."}},
      memory: %{},
      result: nil,
      tool_calls: [
        %{name: "edit", args: %{target: "lib/auth.ex"}, result: %{err: "file locked"}}
      ]
    }, find_turn.id)

IO.puts("  turn #{edit_turn.seq}: (tool/edit ...) -> error")

_ =
  Recorder.record_node(Memory, "session-Q",
    %{
      program: {:def, :plan, %{goal: "harden auth"}, %{}},
      memory: %{plan: %{goal: "harden auth"}},
      result: nil,
      tool_calls: []
    }, edit_turn.id)

IO.puts("  turn 3: (def plan ...)")

IO.puts("\n== QUERY 1: every errored tool call ==")
errored = Query.tool_calls(Memory, "session-Q", status: :error)
IO.puts("  count: #{length(errored)}")
for c <- errored do
  IO.puts("  - #{c.tool}: #{inspect(c.result)} (node #{c.node_id})")
end

IO.puts("\n== QUERY 2: every turn whose program contains (tool/edit ...) ==")
edit_turns = Query.forms(Memory, "session-Q", {:tool_call, "edit"})
IO.puts("  count: #{length(edit_turns)}")
for n <- edit_turns do
  IO.puts("  - seq #{n.seq}: #{n.form_src}")
end

# PROOFS
[%{tool: "edit", status: :error}] = errored
IO.puts("\n  PROOF: exactly one errored tool call, and it is `edit` OK")

[%{seq: 2}] = edit_turns
IO.puts("  PROOF: exactly one turn contains (tool/edit ...), and it is seq 2 OK")

IO.puts("\nC4 QUERY: the agent interrogated its own log and found the broken edit. No LLM ran.\n")
