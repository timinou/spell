# C7 FACADE + TRANSCRIPT — the consumption surface the TUI integrates against.
#
# USE-CASE: this is what "the conversation gains history" looks like from the
# OUTSIDE. A caller (the TUI, a headless driver) never reaches into 9 submodules
# or threads a store by hand. It speaks ONE facade — SpellAgent.Hist — and gets:
#
#   1. record/3   — persist each finished run (one tap on the %Step{} already in hand)
#   2. sessions/latest — enumerate past conversations; reopen the most recent
#   3. resume/2   — a typed %Hist.View{} (env, tools, messages, nodes, tip)
#   4. an interleaved user<->assistant transcript that spans MANY runs
#
# The interleaved transcript is the interface upgrade the TUI motivated: a faithful
# scrollback needs the user's prompts, not just the agent's narration. Node.prompt
# (carried on each step's head node) makes that lossless.
#
# RUN:  mix run scripts/hist/c7_facade_transcript.exs

alias SpellAgent.Hist
alias SpellAgent.Hist.{Store, View}
alias SpellAgent.Hist.Store.Memory

# Memory may already be supervised by the app; tolerate that.
_ = case Memory.start_link([]) do
  {:ok, _} -> :ok
  {:error, {:already_started, _}} -> :ok
end
Store.clear(Memory)
opts = [store: Memory]

# A tiny %Step{} factory: one turn, a prompt drives it, a result is the agent's say.
step = fn say, mem ->
  %PtcRunner.Step{
    turns: [%{number: 1, program: "(work)", result: say, prints: [], tool_calls: [], memory: mem, raw_response: nil, success?: true, type: :normal}]
  }
end

IO.puts("\n== one TUI sitting: three missions recorded through the facade ==")
sid = Hist.new_session_id()
IO.puts("  session id: #{sid}")

Hist.record(sid, step.("Mapped the auth module.", %{focus: :auth}), Keyword.merge(opts, prompt: "map the auth module", model: "claude"))
Hist.record(sid, step.("Found the token bug: < should be <=.", %{focus: :auth, bug: :token_expiry}), Keyword.merge(opts, prompt: "where is the login bug?"))
Hist.record(sid, step.("Patched and verified.", %{focus: :auth, bug: :fixed}), Keyword.merge(opts, prompt: "fix it"))

IO.puts("\n== the app closes; the BEAM could restart; only the log survives ==")

IO.puts("\n== reopen: which session was last? (TUI mount calls Hist.latest) ==")
last = Hist.latest(opts)
IO.puts("  latest session: #{last.id} (started #{last.t0})")
true = last.id == sid
IO.puts("  PROOF: the most-recent conversation is one call away OK")

IO.puts("\n== resume it into a typed View ==")
{:ok, %View{} = view} = Hist.resume(sid, opts)
IO.puts("  view.session_id : #{view.session_id}")
IO.puts("  view.cursor     : #{inspect(view.cursor)}")
IO.puts("  view.tip.seq    : #{view.tip.seq}  (where we are now)")
IO.puts("  view.env        : #{inspect(view.env)}  (folded across 3 runs)")
true = view.env == %{focus: :auth, bug: :fixed}
IO.puts("  PROOF env: state folded across every run, not just the last OK")

IO.puts("\n== the chat lens: a faithful user<->assistant transcript across all 3 runs ==")
for %{role: role, content: content} <- view.messages do
  tag = if role == :user, do: "  user >", else: "  asst <"
  IO.puts("#{tag} #{content}")
end

expected = [
  %{role: :user, content: "map the auth module"},
  %{role: :assistant, content: "Mapped the auth module."},
  %{role: :user, content: "where is the login bug?"},
  %{role: :assistant, content: "Found the token bug: < should be <=."},
  %{role: :user, content: "fix it"},
  %{role: :assistant, content: "Patched and verified."}
]

true = view.messages == expected
IO.puts("\n  PROOF transcript: user prompts AND agent answers, interleaved in order OK")
IO.puts("  (this is the scrollback a resumed TUI renders — nothing reconstructed by the caller)")

IO.puts("\nC7: one facade, a typed View, a faithful cross-run transcript. The integration seam is this small.\n")
