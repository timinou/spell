defmodule SpellAgent.Hist.RefoldTest do
  @moduledoc """
  Refold contract (PLAN-018 W3): rebuilding a replayable native tape from the L1
  node DAG is the FIDELITY-preserving inverse of the Recorder. Unlike the lossy
  chat lens (Reconstitute.to_messages, prose only), a refolded tape carries the
  tool_use / tool_result blocks the provider requires, paired by a deterministic
  id, so the model re-enters seeing its own programs and their results.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Recorder, Refold}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  # Seed a 3-turn session: an opening user prompt, two program turns. Returns the
  # tip node so the caller can set :main.
  defp seed_session do
    a =
      Recorder.record_node(
        Memory,
        "s1",
        %{prompt: "find the bug", program: "(def x 1)", memory: %{x: 1}, result: "ok-a"},
        nil
      )

    b =
      Recorder.record_node(
        Memory,
        "s1",
        %{program: "(tool/sh {:argv [\"ls\"]})", result: "file1\nfile2"},
        a.id
      )

    set_main(b.id)
    {a, b}
  end

  defp set_main(node_id) do
    {:ok, sess} = Store.fetch(Memory, {:session, "s1"})
    Store.put(Memory, {:session, "s1"}, %{sess | cursors: %{main: node_id}})
  end

  describe "to_tape/3 — provider-valid reconstruction" do
    test "every tool_use is paired with exactly one tool_result, in order" do
      seed_session()
      {:ok, tape} = Refold.to_tape(Memory, "s1")

      # Collect tool_use ids from assistant messages and tool_call_ids from tool
      # messages; they must be the same multiset, with no orphan on either side.
      use_ids =
        for %{role: :assistant, tool_calls: calls} <- tape,
            c <- calls,
            do: c["id"]

      result_ids = for %{role: :tool, tool_call_id: id} <- tape, do: id

      assert use_ids != []
      assert Enum.sort(use_ids) == Enum.sort(result_ids)
    end

    test "a tool_use is immediately followed by its tool_result (no interleave)" do
      seed_session()
      {:ok, tape} = Refold.to_tape(Memory, "s1")

      pairs =
        tape
        |> Enum.chunk_every(2, 1, :discard)
        |> Enum.filter(fn [m, _] -> match?(%{role: :assistant, tool_calls: _}, m) end)

      for [assistant, following] <- pairs do
        [%{"id" => id}] = assistant.tool_calls
        assert %{role: :tool, tool_call_id: ^id} = following
      end
    end

    test "the opening user prompt leads the tape as a user message" do
      seed_session()
      {:ok, tape} = Refold.to_tape(Memory, "s1")
      assert %{role: :user, content: "find the bug"} = hd(tape)
    end

    test "the program is carried as the lisp_eval argument (fidelity, not prose)" do
      seed_session()
      {:ok, tape} = Refold.to_tape(Memory, "s1")

      programs =
        for %{role: :assistant, tool_calls: calls} <- tape,
            c <- calls,
            do: get_in(c, ["function", "arguments", "program"])

      assert "(def x 1)" in programs
      assert "(tool/sh {:argv [\"ls\"]})" in programs
    end

    test "the tool result content reflects the recorded result" do
      seed_session()
      {:ok, tape} = Refold.to_tape(Memory, "s1")
      contents = for %{role: :tool, content: c} <- tape, do: c
      assert "ok-a" in contents
      assert "file1\nfile2" in contents
    end
  end

  describe "to_tape/3 — determinism" do
    test "the same DAG refolds to a byte-identical tape every time" do
      seed_session()
      {:ok, t1} = Refold.to_tape(Memory, "s1")
      {:ok, t2} = Refold.to_tape(Memory, "s1")
      assert t1 == t2
    end

    test "the synthesized call id is derived from the node id (stable, prefixed)" do
      {a, _b} = seed_session()
      {:ok, tape} = Refold.to_tape(Memory, "s1")

      # The first program turn (node a) must carry call id "call_<a.id>".
      ids = for %{role: :assistant, tool_calls: calls} <- tape, c <- calls, do: c["id"]
      assert ("call_" <> a.id) in ids
    end
  end

  describe "to_tape/3 — degenerate + edge" do
    test "a prose-only turn (no program) contributes no tool blocks" do
      a =
        Recorder.record_node(
          Memory,
          "s1",
          %{prompt: "hi", program: nil, result: "just talking"},
          nil
        )

      set_main(a.id)
      {:ok, tape} = Refold.to_tape(Memory, "s1")

      # user prompt + a bare assistant message; NO tool_use, NO tool_result.
      refute Enum.any?(tape, &match?(%{role: :tool}, &1))
      refute Enum.any?(tape, &match?(%{tool_calls: _}, &1))
      assert %{role: :assistant, content: "just talking"} in tape
    end

    test "missing session / cursor are explicit errors, never a raise" do
      assert {:error, :no_session} = Refold.to_tape(Memory, "ghost")

      Store.put(Memory, {:session, "s2"}, %SpellAgent.Hist.Session{id: "s2", cursors: %{}})
      assert {:error, :no_cursor} = Refold.to_tape(Memory, "s2")
    end

    test "slice_to_tape/1 is pure over an explicit slice (no store reads)" do
      {a, b} = seed_session()
      slice = SpellAgent.Hist.Reconstitute.slice_to(Memory, b)
      # Pull both nodes directly and refold the explicit list.
      direct = Refold.slice_to_tape(slice)
      {:ok, via_store} = Refold.to_tape(Memory, "s1")
      assert direct == via_store
      assert length(slice) == 2
      assert hd(slice).id == a.id
    end
  end
end
