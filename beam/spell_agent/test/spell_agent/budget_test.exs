defmodule SpellAgent.BudgetTest do
  use ExUnit.Case, async: true

  alias SpellAgent.Budget

  describe "from_opts/1" do
    test "reads max_turns and max_tokens" do
      b = Budget.from_opts(max_turns: 5, max_tokens: 1000)
      assert b.max_turns == 5
      assert b.max_tokens == 1000
    end

    test "cost_ceiling is an alias for max_tokens (the key clock wakes thread)" do
      b = Budget.from_opts(cost_ceiling: 2500)
      assert b.max_tokens == 2500
    end

    test "max_tokens wins over cost_ceiling when both present" do
      b = Budget.from_opts(max_tokens: 100, cost_ceiling: 999)
      assert b.max_tokens == 100
    end

    test "absent / non-positive values become nil (unbounded on that axis)" do
      assert Budget.from_opts([]) == %Budget{max_turns: nil, max_tokens: nil}
      assert Budget.from_opts(max_turns: 0, max_tokens: -5) == %Budget{max_turns: nil, max_tokens: nil}
    end
  end

  describe "run_opts/1 (wiring to the SubAgent budget check)" do
    test "a token ceiling emits token_limit + on_budget_exceeded: :fail" do
      opts = Budget.run_opts(Budget.from_opts(max_tokens: 4000))
      assert opts[:token_limit] == 4000
      assert opts[:on_budget_exceeded] == :fail
    end

    test "no token ceiling emits no budget opts (unbounded)" do
      assert Budget.run_opts(Budget.from_opts(max_turns: 5)) == []
      assert Budget.run_opts(%Budget{}) == []
    end
  end

  describe "turns/2" do
    test "returns the budget's max_turns when set" do
      assert Budget.turns(Budget.from_opts(max_turns: 7), 12) == 7
    end

    test "falls back to the default when unbounded" do
      assert Budget.turns(%Budget{}, 12) == 12
    end
  end

  describe "end-to-end enforcement in Session.run (FEAT-043, the A5 gap)" do
    test "a token ceiling STOPS a run that would otherwise loop to max_turns" do
      # A fake llm that never returns (emits a tool-call program every turn) and
      # reports a high token count. Without budget enforcement the run would loop
      # to max_turns (50); with the token ceiling wired it stops early with
      # :budget_callback_exceeded. This is the exact A5 gap the feature closes:
      # cost_ceiling/max_tokens used to be threaded but never enforced.
      fake_llm = fn _input ->
        {:ok, %{content: ~S|(tool/sh {:argv ["true"]})|, tokens: %{input: 5000, output: 5000}}}
      end

      result =
        SpellAgent.Session.run("loop",
          llm: fake_llm,
          max_turns: 50,
          max_tokens: 8000,
          session_id: "budget-enforce-#{System.unique_integer([:positive])}",
          hist: SpellAgent.Hist.Store.Memory
        )

      assert {:error, %{reason: :budget_callback_exceeded}} = result
    end

    test "an unbounded run (no token ceiling) is NEVER stopped by the budget check" do
      # Same high-token fake llm, but NO max_tokens. Whatever the outcome (the
      # agent may return early or hit max_turns), it must NOT be a
      # budget_callback_exceeded error — the token ceiling is the ONLY thing that
      # triggers that, and it is unset here.
      fake_llm = fn _input ->
        {:ok, %{content: ~S|(tool/sh {:argv ["true"]})|, tokens: %{input: 5000, output: 5000}}}
      end

      result =
        SpellAgent.Session.run("loop",
          llm: fake_llm,
          max_turns: 3,
          session_id: "budget-none-#{System.unique_integer([:positive])}",
          hist: SpellAgent.Hist.Store.Memory
        )

      refute match?({:error, %{reason: :budget_callback_exceeded}}, result),
             "an unbounded run must never trip the token-budget check, got: #{inspect(result)}"
    end
  end

  describe "clamp/2 (resource attenuation — capability only narrows)" do
    test "a child request larger than the parent is clamped to the parent on both axes" do
      child = Budget.from_opts(max_turns: 100, max_tokens: 999_999)
      parent = Budget.from_opts(max_turns: 10, max_tokens: 5000)

      clamped = Budget.clamp(child, parent)
      assert clamped.max_turns == 10
      assert clamped.max_tokens == 5000
    end

    test "a child request smaller than the parent keeps its own (smaller) bound" do
      child = Budget.from_opts(max_turns: 3, max_tokens: 100)
      parent = Budget.from_opts(max_turns: 10, max_tokens: 5000)

      clamped = Budget.clamp(child, parent)
      assert clamped.max_turns == 3
      assert clamped.max_tokens == 100
    end

    test "an absent child bound inherits the parent's bound" do
      child = %Budget{}
      parent = Budget.from_opts(max_turns: 8, max_tokens: 2000)

      clamped = Budget.clamp(child, parent)
      assert clamped.max_turns == 8
      assert clamped.max_tokens == 2000
    end

    test "an absent parent bound leaves the child request standing (root, no ceiling)" do
      child = Budget.from_opts(max_turns: 50, max_tokens: 60_000)
      parent = %Budget{}

      clamped = Budget.clamp(child, parent)
      assert clamped.max_turns == 50
      assert clamped.max_tokens == 60_000
    end

    test "a child can NEVER exceed the parent on any axis (the invariant)" do
      # Property-ish: for any request/parent, each clamped axis <= the parent axis
      # whenever the parent bounds it.
      for req_t <- [1, 10, 1000, nil],
          req_k <- [1, 500, 100_000, nil],
          par_t <- [5, 50, nil],
          par_k <- [1000, 50_000, nil] do
        clamped = Budget.clamp(%Budget{max_turns: req_t, max_tokens: req_k}, %Budget{max_turns: par_t, max_tokens: par_k})

        if par_t, do: assert(clamped.max_turns <= par_t)
        if par_k, do: assert(clamped.max_tokens <= par_k)
      end
    end
  end
end
