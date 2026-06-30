defmodule SpellAgent.Hist.EffectTest do
  @moduledoc """
  Effect classification contract (PLAN-018 W4): reducibility is a function of a
  call's EFFECT CLASS, not its size. The classifier must positively identify reads
  (safe to collapse) and conservatively leave mutation/check/external/unknown
  calls non-collapsible \u2014 a wrong :read drops load-bearing data.
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Hist.Effect

  defp see(name, args), do: %{name: name, args: args}

  test "native read tools classify :read" do
    assert Effect.classify(see("find", %{})) == :read
    assert Effect.read?(see("find", %{}))
  end

  test "native mutation tools classify :mutation" do
    assert Effect.classify(see("edit", %{})) == :mutation
    assert Effect.classify(see("code-apply", %{})) == :mutation
    refute Effect.read?(see("edit", %{}))
  end

  test "shell read heads classify :read" do
    for head <- ["cat", "rg", "ls", "grep", "head", "wc"] do
      assert Effect.classify(see("sh", %{"argv" => [head, "f"]})) == :read
    end
  end

  test "shell check heads classify :check" do
    assert Effect.classify(see("sh", %{"argv" => ["mix", "test"]})) == :check
    assert Effect.classify(see("sh", %{"argv" => ["cargo", "build"]})) == :check
  end

  test "shell external heads classify :external (never collapsible)" do
    assert Effect.classify(see("sh", %{"argv" => ["date"]})) == :external
    assert Effect.classify(see("sh", %{"argv" => ["curl", "x"]})) == :external
    refute Effect.read?(see("sh", %{"argv" => ["date"]}))
  end

  test "shell mutation heads classify :mutation" do
    assert Effect.classify(see("sh", %{"argv" => ["rm", "f"]})) == :mutation
    assert Effect.classify(see("sh", %{"argv" => ["mkdir", "d"]})) == :mutation
  end

  test "an unknown command head is :unknown (conservative, not collapsible)" do
    assert Effect.classify(see("sh", %{"argv" => ["some_novel_binary"]})) == :unknown
    refute Effect.read?(see("sh", %{"argv" => ["some_novel_binary"]}))
  end

  test "an unknown tool name is :unknown" do
    assert Effect.classify(see("mystery-tool", %{})) == :unknown
  end

  test "a computed/absent argv head is :unknown, not a crash" do
    assert Effect.classify(see("sh", %{})) == :unknown
    assert Effect.classify(see("sh", %{"argv" => []})) == :unknown
  end

  test "sh-pipe classifies on the first stage head" do
    assert Effect.classify(see("sh-pipe", %{"stages" => [["cat", "f"], ["grep", "x"]]})) == :read
  end

  test "sed -i (in-place edit) classifies :mutation, not :read" do
    assert Effect.classify(see("sh", %{"argv" => ["sed", "-i", "s/a/b/", "f"]})) == :mutation
    assert Effect.classify(see("sh", %{"argv" => ["sed", "--in-place", "s/a/b/", "f"]})) == :mutation
    assert Effect.classify(see("sh", %{"argv" => ["sed", "-i.bak", "s/a/b/", "f"]})) == :mutation
    # a plain sed (no in-place) is still a read.
    assert Effect.classify(see("sh", %{"argv" => ["sed", "s/a/b/", "f"]})) == :read
  end

  test "an env wrapper is peeled to classify the inner command" do
    assert Effect.classify(see("sh", %{"argv" => ["env", "MIX_ENV=test", "mix", "test"]})) == :check
    assert Effect.classify(see("sh", %{"argv" => ["env", "rm", "f"]})) == :mutation
    assert Effect.classify(see("sh", %{"argv" => ["env", "curl", "x"]})) == :external
    assert Effect.classify(see("sh", %{"argv" => ["env", "cat", "f"]})) == :read
  end

  test "atom-keyed sees entries are read too" do
    assert Effect.classify(%{name: "sh", args: %{argv: ["cat", "f"]}}) == :read
  end
end
