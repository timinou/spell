# C6 WINDOW — lossless compaction (PLAN-001).
#
# USE-CASE: a long session exceeds the context window. PtcRunner's Compaction
# Phase-1 :trim would DELETE old turns; Phase-2 :summarize is unimplemented because
# trimming-by-deletion has nowhere to keep the originals. With a durable history,
# trimming becomes WINDOWING: the full log stays, only the VISIBLE slice narrows,
# trimmed turns are recallable on demand, and a distillation appends a summary while
# the originals remain as its evidence.
#
# RUN:  mix run scripts/hist/c6_window.exs

alias SpellAgent.Hist.{Recorder, Window}
alias SpellAgent.Hist.Store
alias SpellAgent.Hist.Store.Memory

# Memory may already be supervised by the app; tolerate that.
_ = case Memory.start_link([]) do
  {:ok, _} -> :ok
  {:error, {:already_started, _}} -> :ok
end
Store.clear(Memory)

IO.puts("\n== a 10-turn session ==")
last =
  Enum.reduce(1..10, nil, fn i, parent ->
    n = Recorder.record_node(Memory, "long", %{program: "(step #{i})", memory: %{}, result: "turn #{i}: worked on item #{i}"}, parent && parent.id)
    {:ok, sess} = Store.fetch(Memory, {:session, "long"})
    Store.put(Memory, {:session, "long"}, %{sess | cursors: %{main: n.id}})
    n
  end)

IO.puts("  recorded 10 turns, cursor on #{last.id}")

IO.puts("\n== WINDOW: keep initial + 3 recent (what the LLM sees) ==")
{:ok, %{shown: shown, trimmed: trimmed}} = Window.window(Memory, "long", keep_recent: 3, keep_initial: true)
IO.puts("  shown   (seqs): #{inspect(Enum.map(shown, & &1.seq))}")
IO.puts("  trimmed (seqs): #{inspect(Enum.map(trimmed, & &1.seq))}")

total = Store.list(Memory, :node, "long") |> length()
IO.puts("\n  PROOF lossless: #{total} turns still in the store (trim narrowed the VIEW only) OK")
true = total == 10

IO.puts("\n== RECALL: pull a trimmed turn back by keyword ==")
[hit] = Window.recall(Memory, "long", "item 5", keep_recent: 3)
IO.puts("  recalled turn #{hit.seq}: #{inspect(hit.result)}")
true = hit.seq == 5
IO.puts("  PROOF: a trimmed turn is one query away, not gone OK")

IO.puts("\n== DISTILL (Phase-2): summarize the trimmed middle, keep originals ==")
ids = trimmed |> Enum.map(& &1.id)
{:ok, %{summary: summary, mark: mark}} = Window.distill(Memory, "long", ids, summary: "turns 2-7: routine item processing")
IO.puts("  summary node #{summary.id}: #{inspect(summary.say)}")
IO.puts("  clearing mark: #{inspect(mark.kind)} -> #{mark.node_id}")

after_total = Store.list(Memory, :node, "long") |> length()
IO.puts("\n  PROOF: originals preserved (#{after_total} = 10 originals + 1 summary) OK")
true = after_total == 11

IO.puts("\nC6 WINDOW: compaction is reversible windowing + provenance-keeping distillation. Nothing was deleted.\n")
