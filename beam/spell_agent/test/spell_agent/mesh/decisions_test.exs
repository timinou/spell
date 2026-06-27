defmodule SpellAgent.Mesh.DecisionsTest do
  @moduledoc """
  Decisions as stigmergy (FEAT-019, PLAN-019 M6): an agent surfaces a :decision to
  a resolver (human/agent/policy) by POSTING it, and a watch fires a queued task
  when a matching :resolution is posted. No human-in-the-loop subsystem \u2014 the
  human is one more reader/writer of the append-only medium; the flow is the
  EXISTING mesh primitives (post + watch + a resolution record).

  Pins: :decision/:resolution are valid post kinds; the decision->resolution->wake
  flow fires once via the watcher; a gate predicate (the :where over the answer)
  fires only on a matching answer; the open-decisions projection excludes resolved
  ones; resolver symmetry (any author's resolution fires identically).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Clock
  alias SpellAgent.Mesh.Namespace
  alias SpellAgent.Mesh.Store, as: MeshStore
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)

    test_pid = self()
    runner = fn prompt, opts -> send(test_pid, {:woke, prompt, opts}) end

    clock_name = :"dec_clock_#{System.unique_integer([:positive])}"
    start_supervised!({Clock, [name: clock_name, store: Memory, runner: runner]}, id: clock_name)

    watcher_name = :"dec_watcher_#{System.unique_integer([:positive])}"

    start_supervised!(
      {SpellAgent.Mesh.Watcher,
       [name: watcher_name, store: Memory, clock: clock_name, enabled: true]},
      id: watcher_name
    )

    region = "decisions-#{System.unique_integer([:positive])}"
    verbs = Namespace.tools(Memory, "agent", region)
    {:ok, verbs: verbs, region: region}
  end

  defp count_wakes(acc \\ 0) do
    receive do
      {:woke, _, _} -> count_wakes(acc + 1)
    after
      300 -> acc
    end
  end

  describe "post kinds" do
    test "a :decision and a :resolution are valid post kinds", %{verbs: verbs, region: region} do
      assert %{"id" => _, "kind" => "decision"} =
               verbs["black/post"].(%{
                 "kind" => "decision",
                 "payload" => %{"question" => "ship?"}
               })

      assert %{"id" => _, "kind" => "resolution"} =
               verbs["black/post"].(%{
                 "kind" => "resolution",
                 "payload" => %{"decision" => 0, "answer" => %{"choice" => "proceed"}}
               })

      assert length(MeshStore.by_kind(Memory, region, :decision)) == 1
      assert length(MeshStore.by_kind(Memory, region, :resolution)) == 1
    end
  end

  describe "the decision -> resolution -> on-answer flow" do
    test "a matching resolution fires the queued wake", %{verbs: verbs} do
      # 1. agent posts a decision.
      %{"id" => decision_seq} =
        verbs["black/post"].(%{"kind" => "decision", "payload" => %{"question" => "merge?"}})

      # 2. agent watches for the resolution of THIS decision (the queued task is the
      #    :wake prompt, fired when a matching :resolution posts).
      verbs["black/watch"].(%{
        "when" => %{"kind" => "resolution", "where" => %{"decision" => decision_seq}},
        "wake" => %{"prompt" => "decision answered, proceed"}
      })

      # 3. a resolver (here an agent; could be a human dashboard or a policy) posts
      #    the resolution.
      verbs["black/post"].(%{
        "kind" => "resolution",
        "payload" => %{"decision" => decision_seq, "answer" => %{"choice" => "proceed"}}
      })

      # The queued task fires once.
      assert count_wakes() == 1
    end

    test "a gate predicate fires only on a matching answer", %{verbs: verbs} do
      %{"id" => decision_seq} =
        verbs["black/post"].(%{"kind" => "decision", "payload" => %{"question" => "deploy?"}})

      # The watch GATES on choice = proceed (the :where over the answer payload).
      verbs["black/watch"].(%{
        "when" => %{
          "kind" => "resolution",
          "where" => %{"decision" => decision_seq, "choice" => "proceed"}
        },
        "wake" => %{"prompt" => "gated proceed"}
      })

      # A non-matching answer (skip) does NOT fire the gated task.
      verbs["black/post"].(%{
        "kind" => "resolution",
        "payload" => %{"decision" => decision_seq, "choice" => "skip"}
      })

      assert count_wakes() == 0

      # The matching answer (proceed) fires it.
      verbs["black/post"].(%{
        "kind" => "resolution",
        "payload" => %{"decision" => decision_seq, "choice" => "proceed"}
      })

      assert count_wakes() == 1
    end

    test "resolver symmetry: a different author's resolution fires identically",
         %{verbs: verbs, region: region} do
      %{"id" => decision_seq} =
        verbs["black/post"].(%{"kind" => "decision", "payload" => %{"question" => "q"}})

      verbs["black/watch"].(%{
        "when" => %{"kind" => "resolution", "where" => %{"decision" => decision_seq}},
        "wake" => %{"prompt" => "resolved"}
      })

      # A POLICY (a different session id) posts the resolution \u2014 the human/agent/
      # policy resolver is interchangeable (the deepest point of the FEAT).
      policy = Namespace.tools(Memory, "policy-bot", region)

      policy["black/post"].(%{
        "kind" => "resolution",
        "payload" => %{"decision" => decision_seq}
      })

      assert count_wakes() == 1
    end
  end

  describe "open-decisions projection" do
    test "query excludes resolved decisions via a fold over resolutions",
         %{verbs: verbs, region: region} do
      %{"id" => d1} = verbs["black/post"].(%{"kind" => "decision", "payload" => %{"q" => "one"}})
      %{"id" => _d2} = verbs["black/post"].(%{"kind" => "decision", "payload" => %{"q" => "two"}})

      # d1 gets resolved.
      verbs["black/post"].(%{"kind" => "resolution", "payload" => %{"decision" => d1}})

      decisions = MeshStore.by_kind(Memory, region, :decision)
      resolutions = MeshStore.by_kind(Memory, region, :resolution)
      resolved_seqs = Enum.map(resolutions, fn r -> r.payload["decision"] end)

      open = Enum.reject(decisions, fn d -> d.seq in resolved_seqs end)

      # Only the unresolved decision (d2) remains open.
      assert length(open) == 1
      assert hd(open).payload["q"] == "two"
    end
  end
end
