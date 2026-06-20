defmodule SpellAgent.Hist.Bug001RegressionTest do
  @moduledoc """
  Regressions for the six W0-W3 review-swarm findings (BUG-001). Each test fails on
  the pre-fix code and passes after.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Id, Node, Reconstitute, Recorder, Result}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp cursor_on(sid, node_id) do
    {:ok, sess} = Store.fetch(Memory, {:session, sid})
    Store.put(Memory, {:session, sid}, %{sess | cursors: %{main: node_id}})
  end

  # B1 — delta must record a nil binding and honor deletions on fold.
  test "B1: a binding set to nil survives reconstitute" do
    a = Recorder.record_node(Memory, "s", %{program: "(def x nil)", memory: %{x: nil}}, nil)
    cursor_on("s", a.id)
    {:ok, %{env: env}} = Reconstitute.at(Memory, "s")
    assert Map.has_key?(env, :x)
    assert env[:x] == nil
  end

  # B1 (PLAN-008 SEAM 1): the deletion-by-omission class is now UNREPRESENTABLE.
  # The runtime emits the def-delta at the source (introduced ∪ changed) and PTC
  # has no `undef`, so a delta can only add or rebind — never remove. The old
  # `deleted_marker` sentinel is gone; `apply_binds` is a plain merge. A later
  # turn that simply omits a key does NOT drop it (the key persists from its
  # ancestor), which is correct: nothing in PTC can unbind a name.
  test "B1: a delta never carries a deletion marker (removal-by-omission is impossible)" do
    a = Recorder.record_node(Memory, "s", %{program: "(def x 1)", memory: %{x: 1}}, nil)
    b = Recorder.record_node(Memory, "s", %{program: "(def y 2)", memory: %{x: 1, y: 2}}, a.id)
    cursor_on("s", b.id)

    # No binds value is ever a deletion sentinel (the symbol no longer exists).
    refute Enum.any?(b.binds, fn {_k, v} -> v == :__hist_deleted__ end)

    # Both bindings fold through; neither is dropped.
    {:ok, %{env: env}} = Reconstitute.at(Memory, "s")
    assert env[:x] == 1
    assert env[:y] == 2
  end

  # B2 — appended steps must not reuse seq numbers.
  test "B2: two record_step calls produce monotonic, non-colliding seqs" do
    step = fn n ->
      %PtcRunner.Step{
        turns: [
          %{
            number: 1,
            program: "(a)",
            result: nil,
            prints: [],
            tool_calls: [],
            memory: %{a: n},
            raw_response: "r",
            success?: true,
            type: :normal
          }
        ]
      }
    end

    Recorder.record_step(Memory, "s", step.(1))
    Recorder.record_step(Memory, "s", step.(2))

    seqs = Memory |> Store.list(:node, "s") |> Enum.map(& &1.seq) |> Enum.sort()
    assert seqs == Enum.uniq(seqs)
    assert length(seqs) == 2
  end

  # B3 — Memory.list(:session, sid) must scope.
  test "B3: list(:session, sid) returns only that session" do
    Store.put(Memory, {:session, "s1"}, %SpellAgent.Hist.Session{id: "s1"})
    Store.put(Memory, {:session, "s2"}, %SpellAgent.Hist.Session{id: "s2"})
    ids = Memory |> Store.list(:session, "s1") |> Enum.map(& &1.id)
    assert ids == ["s1"]
  end

  # B4 — root (nil parent) must not collide with empty-string parent.
  test "B4: nil parent and empty-string parent yield different ids" do
    refute Id.node_id("(f)", nil) == Id.node_id("(f)", "")
  end

  # B5 — Result classifier covers all error shapes (shared by Query + Tools).
  test "B5: shared Result classifier recognizes every error shape" do
    for err <- [{:error, :x}, %{"err" => 1}, %{"error" => 1}, %{err: 1}, %{error: 1}] do
      assert Result.status(err) == :error
    end

    for ok <- [%{"value" => 1}, %{ok: 1}, :done, {:ok, 1}, "text"] do
      assert Result.status(ok) == :ok
    end
  end

  # B6 — Spans.cost sums string-keyed token maps.
  test "B6: cost sums string-keyed token subtrees" do
    root = %{
      "kind" => "run",
      "tokens" => %{"input" => 3, "output" => 1},
      "children" => [%{"kind" => "tool", "tokens" => %{"tokens" => 7}, "children" => []}]
    }

    assert SpellAgent.Hist.Spans.cost(root) == %{input: 10, output: 1}
  end
end
