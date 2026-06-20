# C12 SPAN PERSISTENCE — drill a RECORDED run's interior, not just the live one (FUP-003).
#
# USE-CASE: the inspector TUI builds a span forest from LIVE telemetry — so when a
# mission ends, its execution interior is gone. FUP-003 adds a bridge:
#   Tui.Store.to_span_root/2   — snapshot the live FLAT forest into the nested
#                                Hist.Node.span_root tree (capture, durable).
#   Tui.Store.from_span_root/1 — rebuild that flat forest from a persisted tree
#                                (replay, so the TUI renders a PAST run like a live one).
# The recorded span tree is READ, never re-derived. Hist.Spans already reads the
# same persisted tree, so cost/trace queries work offline too.
#
# RUN:  mix run scripts/hist/c12_span_persistence.exs

alias SpellAgent.Tui.Store
alias SpellAgent.Hist.{Recorder, Spans}
alias SpellAgent.Hist.Store, as: HistStore
alias SpellAgent.Hist.Store.Memory

{:ok, store} = Store.start_link(name: nil)
:ok = Store.attach(store)
HistStore.clear(Memory)

prefix = [:ptc_runner, :sub_agent]
emit = fn suffix, meta, meas -> :telemetry.execute(prefix ++ suffix, meas, meta) end

IO.puts("\n== a live run: root -> llm + (tool -> nested sub-agent run -> its llm) ==")
emit.([:run, :start], %{span_id: "run1", parent_span_id: nil, agent_name: "root"}, %{})
emit.([:turn, :start], %{span_id: "run1", turn: 1, program: "(plan-and-act)"}, %{})
emit.([:llm, :start], %{span_id: "llm1", parent_span_id: "run1", model: "sonnet"}, %{})

emit.([:llm, :stop], %{span_id: "llm1", parent_span_id: "run1", response: "ok"}, %{
  input_tokens: 100,
  output_tokens: 20
})

emit.([:tool, :start], %{span_id: "tool1", parent_span_id: "run1", tool_name: "sub_agent"}, %{})
emit.([:run, :start], %{span_id: "run2", parent_span_id: "tool1", agent_name: "child"}, %{})
emit.([:llm, :start], %{span_id: "llm2", parent_span_id: "run2", model: "haiku"}, %{})

emit.([:llm, :stop], %{span_id: "llm2", parent_span_id: "run2", response: "done"}, %{
  input_tokens: 10,
  output_tokens: 5
})

emit.([:run, :stop], %{span_id: "run2", status: :ok, return: 42}, %{})

emit.(
  [:tool, :stop],
  %{span_id: "tool1", parent_span_id: "run1", tool_name: "sub_agent", result: %{}},
  %{}
)

emit.(
  [:turn, :stop],
  %{span_id: "run1", turn: 1, program: "(plan-and-act)", result_preview: "42"},
  %{}
)

emit.([:run, :stop], %{span_id: "run1", status: :ok, return: 42}, %{})

live = Store.spans(store)

IO.puts(
  "  live forest: #{map_size(live)} spans, interior = #{inspect(Enum.map(Store.subtree(live, "run1"), & &1.id))}"
)

IO.puts("\n== (1) CAPTURE: snapshot the live forest into a durable span_root tree ==")
root = Store.to_span_root(live, "run1")

IO.puts(
  "  Store.to_span_root(forest, \"run1\") -> nested tree, root=#{root.id} kind=#{root.kind}"
)

IO.puts(
  "    children: #{inspect(Enum.map(root.children, & &1.id))}, tool1 -> #{inspect(Enum.map(hd(tl(root.children)).children, & &1.id))}"
)

IO.puts("\n== (2) PERSIST: record a Hist turn carrying that tree (survives mission end) ==")

node =
  Recorder.record_node(
    Memory,
    "s",
    %{
      program: "(plan-and-act)",
      memory: %{},
      tool_calls: [],
      prints: [],
      raw_response: "r",
      span_root: root
    },
    nil
  )

IO.puts("  recorded node #{String.slice(node.id, 0, 8)} with its execution interior attached")

IO.puts("\n== (3) OFFLINE READ: Hist.Spans queries the persisted tree, no live telemetry ==")
flat = Spans.spans(node) |> Enum.map(fn s -> Map.get(s, :id) || Map.get(s, "id") end)
cost = Spans.cost(node)
IO.puts("  Spans.spans(node) -> #{inspect(flat)}")
IO.puts("  Spans.cost(node)  -> #{inspect(cost)}")
true = cost == %{input: 110, output: 25}
IO.puts("  PROOF: token cost recovered from the durable tree (110 in / 25 out) OK")

IO.puts("\n== (4) REPLAY: rehydrate the FLAT forest the TUI renders, from the persisted tree ==")
rehydrated = Store.from_span_root(node.span_root)
IO.puts("  Store.from_span_root(node.span_root) -> #{map_size(rehydrated)} spans")
live_ids = Store.subtree(live, "run1") |> Enum.map(& &1.id)
rehy_ids = Store.subtree(rehydrated, "run1") |> Enum.map(& &1.id)
IO.puts("    live   interior: #{inspect(live_ids)}")
IO.puts("    replay interior: #{inspect(rehy_ids)}")
true = live_ids == rehy_ids
IO.puts("  PROOF: the recorded run drills identically to the live one OK")
true = rehydrated["run2"].parent_id == "tool1"
IO.puts("  PROOF: the nested sub-agent run survived the disk round-trip OK")

IO.puts(
  "\nC12 SPAN PERSISTENCE: a finished run's interior is durable + replayable. The TUI is no longer live-only.\n"
)
