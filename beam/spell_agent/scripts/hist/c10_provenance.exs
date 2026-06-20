# C10 PROVENANCE — "where was this symbol born, and where did it mutate?" (FUP-001).
#
# USE-CASE: the runtime emits a per-turn def-delta (MOVE-A/A'), split into the
# names a turn FIRST introduced vs the ones it rebound. Hist keeps that split on
# every node (`introduced`). So tracing a symbol's lifetime — first definition +
# every rebind — is a single O(chain) scan. NO env folding, NO snapshot diffing:
# the exact outside-in reconstruction Moves A/B/C exist to kill, now free.
#
# RUN:  mix run scripts/hist/c10_provenance.exs

alias SpellAgent.Hist.{Namespace, Recorder, Store}
alias SpellAgent.Hist.Store.Memory

_ =
  case Memory.start_link([]) do
    {:ok, _} -> :ok
    {:error, {:already_started, _}} -> :ok
  end

Store.clear(Memory)

# Live-shape turns: each carries the runtime def_delta the agent loop now produces.
turn = fn program, def_delta, memory ->
  %{
    program: program,
    def_delta: def_delta,
    memory: memory,
    tool_calls: [],
    prints: [],
    raw_response: "r"
  }
end

IO.puts("\n== a session that defines `plan`, rebinds it twice, and adds `notes` ==")

a =
  Recorder.record_node(
    Memory,
    "s",
    turn.("(def plan \"draft\")", %{introduced: %{"plan" => "draft"}, changed: %{}}, %{
      "plan" => "draft"
    }),
    nil
  )

b =
  Recorder.record_node(
    Memory,
    "s",
    turn.("(def plan \"revised\")", %{introduced: %{}, changed: %{"plan" => "revised"}}, %{
      "plan" => "revised"
    }),
    a.id
  )

c =
  Recorder.record_node(
    Memory,
    "s",
    turn.(
      "(do (def plan \"final\") (def notes []))",
      %{introduced: %{"notes" => []}, changed: %{"plan" => "final"}},
      %{"plan" => "final", "notes" => []}
    ),
    b.id
  )

IO.puts(
  "  turn 1 (#{String.slice(a.id, 0, 8)}): def plan \"draft\", def-intro = #{inspect(a.introduced)}"
)

IO.puts(
  "  turn 2 (#{String.slice(b.id, 0, 8)}): def plan \"revised\", def-intro = #{inspect(b.introduced)}"
)

IO.puts(
  "  turn 3 (#{String.slice(c.id, 0, 8)}): def plan \"final\" + notes, def-intro = #{inspect(c.introduced)}"
)

verbs = Namespace.tools(Memory, "s")

IO.puts("\n== (1) trace `plan` — its birth and every rebind ==")
plan = verbs["hist/provenance"].(%{"sym" => "plan"})
IO.puts("  (hist/provenance {:sym \"plan\"}) ->")

IO.puts(
  "    introduced_at: turn #{plan["introduced_at"]["seq"]} (#{String.slice(plan["introduced_at"]["id"], 0, 8)})"
)

IO.puts("    rebound_at:    turns #{inspect(Enum.map(plan["rebound_at"], & &1["seq"]))}")

true =
  plan["introduced_at"]["id"] == a.id and Enum.map(plan["rebound_at"], & &1["id"]) == [b.id, c.id]

IO.puts("  PROOF: born at turn 1, rebound at turns 2 and 3 OK")

IO.puts("\n== (2) `notes` was born late, never rebound ==")
notes = verbs["hist/provenance"].(%{"sym" => "notes"})

IO.puts(
  "  (hist/provenance {:sym \"notes\"}) -> born@#{notes["introduced_at"]["seq"]}, rebinds=#{inspect(notes["rebound_at"])}"
)

true = notes["introduced_at"]["id"] == c.id and notes["rebound_at"] == []
IO.puts("  PROOF: first defined at turn 3, zero rebinds OK")

IO.puts("\n== (3) PROOF: the PTC lens == the Elixir oracle (no drift) ==")

for sym <- ["plan", "notes", "ghost"] do
  ^sym = verbs["hist/provenance"].(%{"sym" => sym})["sym"]
  true = verbs["hist/provenance"].(%{"sym" => sym}) == verbs["hist/provenance!"].(%{"sym" => sym})
end

IO.puts("  hist/provenance == hist/provenance! for plan, notes, ghost OK")

IO.puts("\n== (4) the question that USED to need a full env fold, now O(chain) ==")

IO.puts(
  "  Before MOVE-A: \"which turn first bound plan?\" => fold every ancestor env, diff, infer."
)

IO.puts("  After  MOVE-A: scan `introduced` sets. The provenance is emitted at the source.")

IO.puts(
  "\nC10 PROVENANCE: definition lineage is a free byproduct of the runtime delta. No reconstruction.\n"
)
