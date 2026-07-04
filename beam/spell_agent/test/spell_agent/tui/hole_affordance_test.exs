defmodule SpellAgent.Tui.HoleAffordanceTest do
  @moduledoc """
  Pure generator tests (PLAN-024 Wave 3 / FEAT-020): schema -> {bindings,
  reactions}, zero TUI. Defends the atom-table-DoS bound (a fixed intent pool
  reused across any number of decisions), the enum/bool/string schema kinds,
  the :tier :policy no-human-affordance rule, and the resolution-post PTC
  source shape.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.HoleAffordance

  describe "enum (:choice) schema" do
    test "one binding + reaction per variant, in declaration order" do
      slot = %{"answer-schema" => %{"choice" => ["proceed", "skip", "defer"]}, "resolves" => 42}
      {bindings, reactions} = HoleAffordance.generate(slot)

      assert length(bindings) == 3
      assert length(reactions) == 3

      chords = Enum.map(bindings, &elem(&1, 0))
      assert chords == ["1", "2", "3"]
    end

    test "each variant's reaction posts a :resolution with its OWN choice + the resolves ref" do
      slot = %{"answer-schema" => %{"choice" => ["proceed", "skip"]}, "resolves" => 7}
      {bindings, reactions} = HoleAffordance.generate(slot)

      [{_chord1, intent1}, {_chord2, intent2}] = bindings
      source1 = Enum.find_value(reactions, fn {i, src} -> i == intent1 && src end)
      source2 = Enum.find_value(reactions, fn {i, src} -> i == intent2 && src end)

      assert source1 =~ ~s(:decision 7)
      assert source1 =~ ~s(:choice "proceed")
      assert source2 =~ ~s(:choice "skip")
      assert source1 =~ "black/post"
      assert source1 =~ ~s(:kind "resolution")
    end

    test "each variant gets a DISTINCT intent (never all sharing one atom)" do
      slot = %{"answer-schema" => %{"choice" => ["a", "b", "c"]}}
      {bindings, _reactions} = HoleAffordance.generate(slot)
      intents = Enum.map(bindings, &elem(&1, 1))
      assert length(Enum.uniq(intents)) == 3
    end

    test "an empty/absent choice list generates nothing" do
      assert HoleAffordance.generate(%{"answer-schema" => %{"choice" => []}}) == {[], []}
      assert HoleAffordance.generate(%{"answer-schema" => %{}}) == {[], []}
    end
  end

  describe "bool schema" do
    test "generates a true/false pair of bindings + reactions" do
      slot = %{"answer-schema" => "bool", "resolves" => 1}
      {bindings, reactions} = HoleAffordance.generate(slot)

      assert length(bindings) == 2
      assert length(reactions) == 2

      assert {"t", true_intent} = Enum.find(bindings, fn {c, _} -> c == "t" end)
      assert {"f", false_intent} = Enum.find(bindings, fn {c, _} -> c == "f" end)
      assert true_intent != false_intent

      true_src = Enum.find_value(reactions, fn {i, s} -> i == true_intent && s end)
      false_src = Enum.find_value(reactions, fn {i, s} -> i == false_intent && s end)
      assert true_src =~ ":choice true"
      assert false_src =~ ":choice false"
    end
  end

  describe "string schema" do
    test "generates ONE binding opening the App's pending-fill state, no reaction (App-intercepted)" do
      slot = %{"answer-schema" => "string", "resolves" => 3}
      {bindings, reactions} = HoleAffordance.generate(slot)

      assert [{"i", _intent}] = bindings
      assert reactions == []
    end
  end

  describe ":tier :policy — no human-facing affordance (doc 16 resolver symmetry)" do
    test "a policy-tiered slot generates nothing" do
      slot = %{"answer-schema" => %{"choice" => ["a", "b"]}, "tier" => "policy"}
      assert HoleAffordance.generate(slot) == {[], []}
    end

    test "an absent :tier defaults to human (generates normally)" do
      slot = %{"answer-schema" => "bool"}
      {bindings, _} = HoleAffordance.generate(slot)
      assert bindings != []
    end
  end

  describe "malformed / unrecognized input — fails closed" do
    test "a non-map slot generates nothing" do
      assert HoleAffordance.generate(nil) == {[], []}
      assert HoleAffordance.generate("garbage") == {[], []}
    end

    test "an unrecognized schema kind generates nothing" do
      assert HoleAffordance.generate(%{"answer-schema" => "not-a-real-kind"}) == {[], []}
      assert HoleAffordance.generate(%{"answer-schema" => 42}) == {[], []}
    end

    test "a missing :answer-schema generates nothing" do
      assert HoleAffordance.generate(%{"resolves" => 1}) == {[], []}
    end
  end

  describe "atom-table-DoS bound: the intent pool is FIXED regardless of decision volume" do
    test "generating affordances for MANY distinct decisions never grows the atom table" do
      # Pay the one-time first-call warmup cost BEFORE the baseline (confirmed
      # via isolation: identical repeated calls after the first cost nothing
      # further — the same per-process first-use module/pattern-resolution
      # noise documented in atom_dos_property_test.exs, not a leak).
      HoleAffordance.generate(%{"answer-schema" => %{"choice" => ["warmup"]}, "resolves" => 0})
      HoleAffordance.generate(%{"answer-schema" => "bool", "resolves" => 0})

      before = :erlang.system_info(:atom_count)

      for decision_seq <- 1..200 do
        HoleAffordance.generate(%{
          "answer-schema" => %{"choice" => ["proceed", "skip", "defer"]},
          "resolves" => decision_seq
        })

        HoleAffordance.generate(%{"answer-schema" => "bool", "resolves" => decision_seq})
      end

      assert :erlang.system_info(:atom_count) == before
    end

    test "intent_pool/0 is bounded and every generated intent is a member of it" do
      pool = MapSet.new(HoleAffordance.intent_pool())
      assert MapSet.size(pool) <= 40

      for schema <- [%{"choice" => ["x", "y", "z"]}, "bool"] do
        {bindings, _} = HoleAffordance.generate(%{"answer-schema" => schema})

        for {_chord, intent} <- bindings do
          assert MapSet.member?(pool, intent), "#{inspect(intent)} not in the bounded pool"
        end
      end
    end

    test "a schema with more variants than the chord pool truncates rather than raising" do
      variants = for i <- 1..100, do: "v#{i}"
      slot = %{"answer-schema" => %{"choice" => variants}}
      {bindings, reactions} = HoleAffordance.generate(slot)

      # Bounded by the chord pool (35: 1-9 then a-z), never all 100.
      assert length(bindings) <= 35
      assert length(reactions) == length(bindings)
    end
  end

  describe "string-keyed slot maps" do
    test "a fully string-keyed slot (the PLAN-012 layout-tree convention) resolves" do
      slot = %{"answer-schema" => "bool", "resolves" => 1, "tier" => "human"}
      {bindings, _} = HoleAffordance.generate(slot)
      assert length(bindings) == 2
    end
  end
end
