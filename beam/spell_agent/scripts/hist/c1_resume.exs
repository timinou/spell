# C1 RESUME — defeat amnesia across a session boundary (PLAN-001).
#
# USE-CASE: an agent works a task, computes intermediate state (`(def plan ...)`),
# and authors a tool mid-conversation (`define-tool blast-radius`). The session
# closes. On reopen, the agent should wake up KNOWING its computed values and with
# its self-authored tool live — WITHOUT re-deriving anything and WITHOUT any LLM or
# tool call. This script shows that the record -> reconstitute path delivers exactly
# that, deterministically.
#
# RUN:  mix run scripts/hist/c1_resume.exs

alias SpellAgent.Hist.{Reconstitute, Recorder, ToolDef}
alias SpellAgent.Hist.Store
alias SpellAgent.Hist.Store.Memory

# Memory may already be supervised by the app; tolerate that.
_ = case Memory.start_link([]) do
  {:ok, _} -> :ok
  {:error, {:already_started, _}} -> :ok
end
Store.clear(Memory)

IO.puts("\n== SESSION 1: the agent works, computes state, authors a tool ==")

# Turn 1: derive a plan value into the env.
t1 = Recorder.record_node(Memory, "session-A",
  %{program: "(def plan {:goal \"map auth\" :step 1})",
    memory: %{plan: %{goal: "map auth", step: 1}},
    result: "drafted a plan"}, nil)
IO.puts("  turn 1: defined `plan`  -> node #{t1.id}")

# Turn 2: author a tool at runtime (homoiconic: source-as-data).
t2 = Recorder.record_node(Memory, "session-A",
  %{program: ~S|(tool/define-tool {:name "blast-radius" :source "(tool/find {:target (str data/sym \" def->\")})"})|,
    memory: %{plan: %{goal: "map auth", step: 1}},
    result: "authored blast-radius",
    tool_calls: [%{name: "define-tool", args: %{"name" => "blast-radius"}}]}, t1.id)
IO.puts("  turn 2: authored tool `blast-radius`  -> node #{t2.id}")

# Turn 3: advance the computed state.
t3 = Recorder.record_node(Memory, "session-A",
  %{program: "(def plan (assoc plan :step 2))",
    memory: %{plan: %{goal: "map auth", step: 2}},
    result: "advanced to step 2"}, t2.id)
IO.puts("  turn 3: advanced `plan` to step 2  -> node #{t3.id}")

# The tool got promoted to durable storage (C3 will automate this; here we assert
# the resume path restores a durable ToolDef).
Store.put(Memory, {:tool, "blast-radius"},
  %ToolDef{name: "blast-radius", params: [:sym],
           source: ~S|(tool/find {:target (str data/sym " def->")})|,
           scope: :durable, origin: %{session: "session-A", node_id: t2.id}})

# Cursor :main sits on the last turn.
{:ok, sess} = Store.fetch(Memory, {:session, "session-A"})
Store.put(Memory, {:session, "session-A"}, %{sess | cursors: %{main: t3.id}})

IO.puts("\n== ...session closes, BEAM could restart, the log is the only survivor... ==")

IO.puts("\n== SESSION 2: reopen — reconstitute WITHOUT executing anything ==")
{:ok, state} = Reconstitute.at(Memory, "session-A")

IO.puts("  rebuilt env     : #{inspect(state.env)}")
IO.puts("  restored tools  : #{inspect(Enum.map(state.tools, & &1.name))}")
IO.puts("  chat lens (says): #{inspect(Enum.map(state.messages, & &1.content))}")

# PROOFS
plan = state.env[:plan]
true = plan == %{goal: "map auth", step: 2}
IO.puts("\n  PROOF env: `plan` survived at step #{plan.step} (no re-derivation) OK")

[%ToolDef{name: "blast-radius", source: src}] = state.tools
true = is_binary(src)
IO.puts("  PROOF tool: `blast-radius` is live with its source restored OK")

# Determinism: a second reconstitute is byte-identical.
{:ok, again} = Reconstitute.at(Memory, "session-A")
true = again.env == state.env
IO.puts("  PROOF deterministic: second reconstitute identical OK")

IO.puts("\nC1 RESUME: the agent woke up with its state and its self-authored tool. No LLM, no tools ran.\n")
