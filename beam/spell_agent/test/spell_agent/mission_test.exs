defmodule SpellAgent.MissionTest do
  @moduledoc """
  Rate-controller contract (PLAN-018 W5): the reduce-vs-cache decision is a
  zero-inference function of cheap token estimates + the remaining budget. The
  tests pin the decision against the closed-form break-even K*, the ladder rungs,
  and the memo (a re-entry at the same watermark is a free lookup).
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Mission
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  # Generous ceilings so the overflow rungs do not fire unless a test wants them.
  defp inputs(over) do
    Map.merge(%{window_soft: 1_000_000, window_hard: 2_000_000}, over)
  end

  describe "the economic trigger (K > K*)" do
    test "reduces when remaining turns exceed the break-even" do
      f = 10_000
      r = 2_000
      kstar = Mission.break_even(f, r)

      # one turn past break-even -> reduce.
      d = Mission.decide(inputs(%{tok_full: f, tok_reduced: r, remaining_turns: ceil(kstar) + 1}))
      assert d == {:reduce, :lossy}
    end

    test "caches when remaining turns are below the break-even" do
      f = 10_000
      r = 2_000
      kstar = Mission.break_even(f, r)

      # short of break-even -> cache (not enough P-frames to amortize the keyframe).
      d = Mission.decide(inputs(%{tok_full: f, tok_reduced: r, remaining_turns: max(0, floor(kstar) - 1)}))
      assert d == :cache
    end

    test "the decision boundary matches savings(K) crossing zero" do
      f = 8_000
      r = 1_500
      kstar = Mission.break_even(f, r)

      below = max(0, floor(kstar) - 1)
      above = ceil(kstar) + 1

      # savings is negative below K* and positive above it.
      assert Mission.savings(f, r, below) <= 0
      assert Mission.savings(f, r, above) > 0

      assert Mission.decide(inputs(%{tok_full: f, tok_reduced: r, remaining_turns: below})) == :cache

      assert Mission.decide(inputs(%{tok_full: f, tok_reduced: r, remaining_turns: above})) ==
               {:reduce, :lossy}
    end
  end

  describe "the overflow ladder" do
    test "a hard-overflow tape reduces with the lossy tier" do
      d =
        Mission.decide(%{
          tok_full: 500_000,
          tok_reduced: 100_000,
          remaining_turns: 0,
          window_soft: 100_000,
          window_hard: 300_000
        })

      assert d == {:reduce, :lossy}
    end

    test "a soft-overflow tape reduces (lossy) even with no remaining turns" do
      d =
        Mission.decide(%{
          tok_full: 150_000,
          tok_reduced: 50_000,
          remaining_turns: 0,
          window_soft: 100_000,
          window_hard: 300_000
        })

      assert d == {:reduce, :lossy}
    end

    test "hard overflow dominates the economic trigger" do
      # even if K is below break-even, a hard overflow forces a lossy reduce.
      d =
        Mission.decide(%{
          tok_full: 500_000,
          tok_reduced: 499_000,
          remaining_turns: 0,
          window_soft: 100_000,
          window_hard: 300_000
        })

      assert d == {:reduce, :lossy}
    end
  end

  describe "nothing-reducible" do
    test "a tape with no reducible tokens never reduces below the soft ceiling" do
      # tok_reduced == tok_full -> break_even is :infinity -> always cache.
      d = Mission.decide(inputs(%{tok_full: 50_000, tok_reduced: 50_000, remaining_turns: 1_000}))
      assert d == :cache
    end

    test "break_even is :infinity when nothing is reducible" do
      assert Mission.break_even(1000, 1000) == :infinity
      assert Mission.break_even(1000, 1200) == :infinity
    end
  end

  describe "S5: input tolerance + soft-rung guard" do
    test "accepts the string-keyed hist/reducibility stats shape" do
      # This is the actual reducer output; decide/1 must consume it directly.
      stats = %{
        "tok_full" => 150_000,
        "tok_reduced" => 50_000,
        "nodes" => 7
      }

      d = Mission.decide(Map.merge(%{"window_soft" => 100_000, "window_hard" => 300_000, "remaining_turns" => 0}, stats))
      assert d == {:reduce, :lossy}
    end

    test "an error map or garbage input degrades to :cache (best-effort)" do
      assert Mission.decide(%{"err" => "estimate failed"}) == :cache
      assert Mission.decide(%{}) == :cache
      assert Mission.decide(:not_a_map) == :cache
      assert Mission.decide(nil) == :cache
    end

    test "soft overflow does NOT reduce when the tape cannot shrink (F <= R)" do
      # pathological estimate: reduced is not smaller -> a reduce cannot
      # relieve the soft overflow -> cache (let hard overflow force lossy).
      d =
        Mission.decide(%{
          tok_full: 150_000,
          tok_reduced: 200_000,
          remaining_turns: 0,
          window_soft: 100_000,
          window_hard: 300_000
        })

      assert d == :cache
    end

    test "missing ceilings default to no-overflow (only the economic trigger fires)" do
      # no window_* fields -> ceilings :infinity -> overflow rungs never fire; with
      # K below break-even and reducible tokens, the verdict is cache.
      d = Mission.decide(%{tok_full: 10_000, tok_reduced: 2_000, remaining_turns: 0})
      assert d == :cache
    end
  end

  describe "the reduction memo" do
    setup do
      Store.clear(Memory)
      :ok
    end

    test "a miss computes and stores; a hit reuses without recomputing" do
      {:ok, agent} = Agent.start_link(fn -> 0 end)
      compute = fn -> Agent.update(agent, &(&1 + 1)); [%{role: :user, content: "x"}] end

      first = Mission.memoized_reduce(Memory, "s", 42, "policy-abc", compute)
      second = Mission.memoized_reduce(Memory, "s", 42, "policy-abc", compute)

      assert first == second
      # compute ran exactly ONCE: the second call was a free memo hit.
      assert Agent.get(agent, & &1) == 1
    end

    test "a different watermark or policy is a distinct memo entry (recomputes)" do
      {:ok, agent} = Agent.start_link(fn -> 0 end)
      compute = fn -> Agent.update(agent, &(&1 + 1)); :reduced end

      Mission.memoized_reduce(Memory, "s", 42, "policy-abc", compute)
      Mission.memoized_reduce(Memory, "s", 43, "policy-abc", compute)
      Mission.memoized_reduce(Memory, "s", 42, "policy-xyz", compute)

      # three distinct keys -> three computes.
      assert Agent.get(agent, & &1) == 3
    end

    test "the memo key depends on all three of session, watermark, policy" do
      assert Mission.memo_key("s", 1, "p") == {:reduced, "s", 1, "p"}
      refute Mission.memo_key("s", 1, "p") == Mission.memo_key("s", 2, "p")
      refute Mission.memo_key("s", 1, "p") == Mission.memo_key("t", 1, "p")
      refute Mission.memo_key("s", 1, "p") == Mission.memo_key("s", 1, "q")
    end
  end
end
