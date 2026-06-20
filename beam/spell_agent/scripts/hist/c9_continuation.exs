# C9 CONTINUATION — the missing wire: history feeds the NEXT turn's LLM.
#
# THE BUG (from the inspector screenshot): the agent named itself "Recursion" on
# turn 1, then on turn 2 ("what is your name?") answered "Claude" — as if turn 1
# never happened. History was RECORDED and DISPLAYED, but never fed back into the
# model. Every turn started cold.
#
# THE FIX (PLAN-006): Session.run now
#   1. loads the L0 continuation (verbatim tape + def env) BEFORE the run,
#   2. threads it as initial_messages / initial_memory,
#   3. records the new tape after — so each turn extends the last.
#
# This script drives a FAKE llm that is HONEST: it answers from the conversation
# it is shown. On turn 1 it invents a name; on turn 2 it echoes whatever name it
# can find in the replayed transcript. With the wire, the name survives. Without
# it, turn 2 would see nothing and fall back. No network.
#
# RUN:  mix run scripts/hist/c9_continuation.exs

alias SpellAgent.{Hist, Session}
alias SpellAgent.Hist.Store
alias SpellAgent.Hist.Store.Memory

_ =
  case Memory.start_link([]) do
    {:ok, _} -> :ok
    {:error, {:already_started, _}} -> :ok
  end

Store.clear(Memory)
opts = [session_id: "demo", hist: Memory, max_turns: 1]

# A fake llm that answers a fixed line as PLAIN TEXT. In :tool_call transport a
# fenced program is rejected ("call lisp_eval instead"); a plain assistant answer
# completes the turn as the direct final answer. That is the honest one-shot here.
answer = fn say -> fn _req -> {:ok, say} end end

# An llm that DERIVES its answer from the transcript it is shown: it scans the
# replayed messages for a remembered name. This is the honest test of "did the
# model actually see turn 1?".
recall_name = fn req ->
  text =
    req.messages
    |> Enum.map(fn m ->
      c = Map.get(m, :content) || Map.get(m, "content")

      cond do
        is_binary(c) ->
          c

        is_list(c) ->
          Enum.map_join(c, " ", fn b ->
            (is_map(b) && (Map.get(b, :text) || Map.get(b, "text"))) || ""
          end)

        true ->
          ""
      end
    end)
    |> Enum.join("\n")

  remembered =
    case Regex.run(~r/I am ([A-Z][a-z]+)/, text) do
      [_, name] -> "My name is #{name}, as I told you."
      _ -> "I don't have a name yet."
    end

  {:ok, remembered}
end

IO.puts("\n== turn 1: ask the agent to name itself ==")

{:ok, t1} =
  Session.run(
    "Hi, who are you? Give yourself a name.",
    [llm: answer.("I am Recursion, a homoiconic agent.")] ++ opts
  )

IO.puts("  user > Hi, who are you? Give yourself a name.")
IO.puts("  asst < #{t1}")

IO.puts("\n== the L0 continuation now holds the verbatim tape ==")
%{tape: tape, memory: _} = Hist.continuation("demo", store: Memory)
IO.puts("  tape has #{length(tape)} message(s); system prompt is NOT among them:")
has_system? = Enum.any?(tape, &(Map.get(&1, :role) == :system or Map.get(&1, "role") == "system"))
IO.puts("  system in tape? #{has_system?}  (must be false)")
false = has_system?

IO.puts("\n== turn 2: ask the name back — the llm answers ONLY from what it is shown ==")
{:ok, t2} = Session.run("What is your name?", [llm: recall_name] ++ opts)
IO.puts("  user > What is your name?")
IO.puts("  asst < #{t2}")

IO.puts("\n== PROOF ==")

if t2 =~ "Recursion" do
  IO.puts("  OK turn 2 recalled the name from turn 1 — history fed the model.")
  IO.puts("  (before PLAN-006 this said \"I don't have a name yet\" — the screenshot bug.)")
else
  IO.puts("  FAIL turn 2 did not see turn 1: #{inspect(t2)}")
  System.halt(1)
end

IO.puts("\n== counter-proof: a FRESH session id sees nothing (cold start is correct) ==")

{:ok, cold} =
  Session.run("What is your name?",
    llm: recall_name,
    session_id: "other",
    hist: Memory,
    max_turns: 1
  )

IO.puts("  asst < #{cold}")
true = cold =~ "don't have a name"
IO.puts("  OK a different conversation does NOT inherit this one's memory.\n")

IO.puts("C9: the wire is closed — each turn replays the real prior conversation.\n")
