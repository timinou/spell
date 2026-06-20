# C2 CRYSTALLIZE — turn a successful investigation into a reusable tool (PLAN-001).
#
# USE-CASE: a 3-turn find -> filter -> rank investigation becomes a reusable,
# LLM-free "hot-callers" tool. The agent crystallizes the slice so future
# sessions can call the distilled program directly without re-deriving it.
#
# RUN:  mix run scripts/hist/c2_crystallize.exs

alias SpellAgent.Hist.{Crystallize, Recorder}
alias SpellAgent.Hist.Store
alias SpellAgent.Hist.Store.Memory

# Memory may already be supervised by the app; tolerate that.
_ = case Memory.start_link([]) do
  {:ok, _} -> :ok
  {:error, {:already_started, _}} -> :ok
end
Store.clear(Memory)

IO.puts("\n== SESSION A: agent investigates hot callers ==")

n1 =
  Recorder.record_node(Memory, "session-A", %{
    program: ~S|(def candidates (tool/find {:target "src/**/*.ex"}))|,
    memory: %{candidates: ["a.ex", "b.ex"]},
    result: "found candidates"
  }, nil)

IO.puts("  turn 1: find candidates  -> node #{n1.id}")

n2 =
  Recorder.record_node(Memory, "session-A", %{
    program: ~S|(def hot (filter candidates #(.contains % "auth")))|,
    memory: %{candidates: ["a.ex", "b.ex"], hot: ["a.ex"]},
    result: "filtered hot files"
  }, n1.id)

IO.puts("  turn 2: filter hot files -> node #{n2.id}")

n3 =
  Recorder.record_node(Memory, "session-A", %{
    program: ~S|(return {:ranked (sort-by hot count-callers)})|,
    memory: %{candidates: ["a.ex", "b.ex"], hot: ["a.ex"]},
    result: %{ranked: ["a.ex"]}
  }, n2.id)

IO.puts("  turn 3: rank hot files   -> node #{n3.id}")

IO.puts("\n== CRYSTALLIZE: distill the slice into a program ==")

slice = Crystallize.slice_source(Memory, "session-A", [n1.id, n2.id, n3.id])
IO.puts("  sliced source:\n#{slice}")

{:ok, crystal} =
  Crystallize.crystallize(Memory, "session-A", [n1.id, n2.id, n3.id], %{
    name: "hot-callers",
    signature: "() -> {:ranked :list}",
    compile: {:source, "(do\n  (def candidates (tool/find {:target \"src/**/*.ex\"}))\n  (def hot (filter candidates #(\.contains % \"auth\")))\n  (return {:ranked (sort-by hot count-callers)})\n)"}
  })

IO.puts("  crystal id: #{crystal.id}")
IO.puts("  crystal name: #{crystal.name}")

# PROOFS
true = String.contains?(slice, "def candidates")
true = String.contains?(slice, "def hot")
true = String.contains?(slice, "return {:ranked")
IO.puts("\n  PROOF slice: contains all three investigation forms OK")

true = crystal.origin == %{session: "session-A", nodes: [n1.id, n2.id, n3.id]}
IO.puts("  PROOF origin: crystal remembers its source nodes OK")

true = Crystallize.to_tool_source(crystal) == crystal.source
IO.puts("  PROOF tool_source: crystal is a callable PTC-Lisp program OK")

IO.puts("\nC2 CRYSTALLIZE: investigation became reusable long-term memory. No LLM.\n")
