defmodule SpellAgent.Hist.ContinuationTest do
  @moduledoc """
  The linear-continuation contract (PLAN-006): a second turn under one session id
  SEES the first turn. This is the regression for the screenshot bug — the agent
  named itself "Recursion" on turn 1 then answered as "Claude" on turn 2 because
  the prior turn was recorded + displayed but never fed back into the LLM call.

  The contract under test is observable at the LLM boundary: we drive a FAKE llm
  that captures the `messages` it receives, and assert turn 2's request contains
  turn 1's user prompt AND assistant answer. No network.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.{Config, Hist, Session}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    # This suite asserts VERBATIM continuation-tape ordering, so pin the
    # mission-boundary rate-controller OFF (FEAT-036 defaults it on): a reduce
    # would legitimately rewrite the tape, which is a different concern tested by
    # rate_controller_test. Restore the global value after (Config is a singleton).
    prior_auto = Config.get("hist.auto_reduce")
    Config.put("hist.auto_reduce", false)
    on_exit(fn -> Config.put("hist.auto_reduce", prior_auto) end)
    :ok
  end

  # A fake llm that (a) answers with a fixed assistant line and (b) shoves the
  # request's messages onto a collector so the test can inspect what the model
  # saw. In :tool_call transport a fenced program is rejected ("call lisp_eval");
  # a PLAIN assistant answer completes the turn as the direct final answer, so we
  # return plain text and get a clean {:ok, answer} one-shot.
  defp capturing_llm(collector, answer) do
    fn req ->
      send(collector, {:llm_messages, req.messages})
      {:ok, answer}
    end
  end

  test "turn 2's LLM request replays turn 1's prompt and answer" do
    me = self()

    # Turn 1: name yourself. Plain-text completion => a clean {:ok, answer}.
    assert {:ok, "I am Recursion."} =
             Session.run("Hi who are you? Give yourself a name",
               llm: capturing_llm(me, "I am Recursion."),
               session_id: "s",
               hist: Memory,
               max_turns: 1
             )

    # drain turn-1 capture so we only inspect turn 2's request
    flush_llm_messages()

    # Turn 2: ask the name back.
    Session.run("What is your name?",
      llm: capturing_llm(me, "Recursion, as I said."),
      session_id: "s",
      hist: Memory,
      max_turns: 1
    )

    msgs = last_llm_messages()
    flat = transcript_text(msgs)

    # The model MUST have seen turn 1 (both sides) before answering turn 2.
    assert flat =~ "Hi who are you?"
    assert flat =~ "I am Recursion."
    assert flat =~ "What is your name?"

    # And ordering: the prior turn precedes the new prompt.
    assert index_of(flat, "Hi who are you?") < index_of(flat, "What is your name?")
  end

  test "continuation/2 returns the stored tape + memory after a run" do
    Session.run("first",
      llm: capturing_llm(self(), "ok one"),
      session_id: "s",
      hist: Memory,
      max_turns: 1
    )

    %{tape: tape, memory: memory} = Hist.continuation("s", store: Memory)
    assert is_list(tape) and tape != []
    assert is_map(memory)

    # The stored tape carries the user prompt and the assistant answer, and NEVER
    # a system message (regenerated each turn).
    flat = transcript_text(tape)
    assert flat =~ "first"
    assert flat =~ "ok one"
    refute Enum.any?(tape, &(Map.get(&1, :role) == :system or Map.get(&1, "role") == "system"))
  end

  test "continuation/2 is empty for an unrecorded session (cold start)" do
    assert %{tape: [], memory: %{}} = Hist.continuation("never-seen", store: Memory)
  end

  test "a store that raises on the READ path degrades to a cold start, not a crash" do
    # Mirror of the SEAM-1 best-effort invariant on the feed-forward READ side: a
    # sick store must not crash the mission. The continuation load is wrapped, so
    # the run still completes (cold).
    defmodule ReadBrokenStore do
      @behaviour SpellAgent.Hist.Store
      def put(_, _), do: :ok
      def fetch(_), do: raise("boom-read")
      def delete(_), do: :ok
      def list(_, _ \\ nil), do: []
      def clear, do: :ok
    end

    result =
      Session.run("mission",
        llm: capturing_llm(self(), "ok"),
        session_id: "s",
        hist: ReadBrokenStore,
        max_turns: 1
      )

    assert match?({:ok, _}, result) or match?({:error, _}, result)
  end

  test "the cont buffer is overwritten, not appended, across turns" do
    Session.run("a",
      llm: capturing_llm(self(), "ra"),
      session_id: "s",
      hist: Memory,
      max_turns: 1
    )

    Session.run("b",
      llm: capturing_llm(self(), "rb"),
      session_id: "s",
      hist: Memory,
      max_turns: 1
    )

    # Exactly one Cont per session (single-valued), and it is the latest tape.
    conts = Store.list(Memory, :cont, "s")
    assert length(conts) == 1

    flat = transcript_text(hd(conts).tape)
    # cumulative tape => both turns present, newest last
    assert flat =~ "a" and flat =~ "b"
    assert index_of(flat, "ra") < index_of(flat, "b")
  end

  # --- helpers ---

  defp flush_llm_messages do
    receive do
      {:llm_messages, _} -> flush_llm_messages()
    after
      0 -> :ok
    end
  end

  # The LAST captured request's messages (turn 2 issues one llm call at max_turns 1).
  defp last_llm_messages do
    collect_llm_messages([])
    |> List.last()
    |> Kernel.||([])
  end

  defp collect_llm_messages(acc) do
    receive do
      {:llm_messages, m} -> collect_llm_messages([m | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  defp transcript_text(messages) do
    messages
    |> Enum.map(fn m -> content_string(Map.get(m, :content) || Map.get(m, "content")) end)
    |> Enum.join("\n")
  end

  # content can be a string or a list of blocks (tool_use / tool_result) — flatten
  # to text so a substring assertion works across shapes.
  defp content_string(c) when is_binary(c), do: c
  defp content_string(c) when is_list(c), do: Enum.map_join(c, "\n", &block_text/1)
  defp content_string(c), do: inspect(c)

  defp block_text(b) when is_map(b),
    do: Map.get(b, :text) || Map.get(b, "text") || Map.get(b, :content) || inspect(b)

  defp block_text(b), do: inspect(b)

  defp index_of(haystack, needle) do
    case :binary.match(haystack, needle) do
      {i, _} -> i
      :nomatch -> -1
    end
  end
end
