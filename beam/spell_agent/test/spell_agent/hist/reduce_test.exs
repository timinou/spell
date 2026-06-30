defmodule SpellAgent.Hist.ReduceTest do
  @moduledoc """
  Lossless reduction contract (PLAN-018 W4): the lossless tier shrinks the tape
  payload while PROVABLY preserving the reconstructed def-env and the error-
  recovery evidence. The defining test is fold_env(reduce(slice)) ==
  fold_env(slice); the rest pin each transform's specific behavior and its
  exemptions (errors never dropped, a read before a rebind keeps the bind).
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Hist.{Node, Reduce}

  # Build a node with explicit form (AST), binds, and sees. seq drives order.
  defp node(seq, opts) do
    %Node{
      id: "n#{seq}",
      session: "s",
      seq: seq,
      parent_id: if(seq > 0, do: "n#{seq - 1}"),
      form: Keyword.get(opts, :form, nil),
      binds: Keyword.get(opts, :binds, %{}),
      sees: Keyword.get(opts, :sees, []),
      prints: Keyword.get(opts, :prints, [])
    }
  end

  defp see(name, args, result), do: %{name: name, args: args, result: result}

  describe "the lossless proof — fold_env(reduced) == fold_env(full)" do
    test "holds for a slice exercising every transform" do
      slice = [
        # x bound, then rebound at n2 with no read between -> dead in n0.
        node(0, binds: %{x: 1}, form: {:def, :x, {:literal, 1}, %{}}, prints: ["noise"]),
        # a duplicate ok read of the same path (CSE / stale targets).
        node(1,
          binds: %{y: 2},
          form: {:def, :y, {:literal, 2}, %{}},
          sees: [see("sh", %{"argv" => ["cat", "f"]}, "DATA")]
        ),
        node(2,
          binds: %{x: 9},
          form: {:def, :x, {:literal, 9}, %{}},
          sees: [see("sh", %{"argv" => ["cat", "f"]}, "DATA")]
        )
      ]

      assert Reduce.fold_env(Reduce.lossless(slice)) == Reduce.fold_env(slice)
      # sanity: the env is what we expect.
      assert Reduce.fold_env(slice) == %{x: 9, y: 2}
    end

    test "holds when a binding is read before it is rebound (must NOT be dropped)" do
      slice = [
        node(0, binds: %{x: 1}, form: {:def, :x, {:literal, 1}, %{}}),
        # n1 READS x -> x@n0 is live and must survive.
        node(1, binds: %{z: 5}, form: {:call, {:var, "log"}, [{:var, "x"}]}),
        node(2, binds: %{x: 9}, form: {:def, :x, {:literal, 9}, %{}})
      ]

      reduced = Reduce.lossless(slice)
      assert Reduce.fold_env(reduced) == Reduce.fold_env(slice)
      # x@n0 survived (the read protected it): its binds still carry x.
      assert Enum.at(reduced, 0).binds == %{x: 1}
    end
  end

  describe "dead-bind-elim" do
    test "drops a binding rebound before any read" do
      slice = [
        node(0, binds: %{x: 1}, form: {:def, :x, {:literal, 1}, %{}}),
        node(1, binds: %{x: 2}, form: {:def, :x, {:literal, 2}, %{}})
      ]

      reduced = Reduce.lossless(slice)
      # x@n0 is dead (rebound at n1, never read) -> dropped from n0's binds.
      assert Enum.at(reduced, 0).binds == %{}
      assert Enum.at(reduced, 1).binds == %{x: 2}
      # env still reconstructs identically.
      assert Reduce.fold_env(reduced) == %{x: 2}
    end

    test "keeps a binding that is never rebound" do
      slice = [
        node(0, binds: %{x: 1}, form: {:def, :x, {:literal, 1}, %{}}),
        node(1, binds: %{y: 2}, form: {:def, :y, {:literal, 2}, %{}})
      ]

      reduced = Reduce.lossless(slice)
      assert Enum.at(reduced, 0).binds == %{x: 1}
    end

    test "a read anywhere in the window keeps the bind (write-barrier)" do
      # x bound @0, read @1, rebound @2 -> @0 is LIVE (read before rebind).
      slice = [
        node(0, binds: %{x: 1}, form: {:def, :x, {:literal, 1}, %{}}),
        node(1, binds: %{}, form: {:var, "x"}),
        node(2, binds: %{x: 3}, form: {:def, :x, {:literal, 3}, %{}})
      ]

      reduced = Reduce.lossless(slice)
      assert Enum.at(reduced, 0).binds == %{x: 1}
    end
  end

  describe "tool-cse" do
    test "two identical-result CHECK calls CSE: the duplicate refs the keeper" do
      # A check (mix test) is not stale-collapsible (not :read), so identical
      # results are de-duplicated by tool-cse: the FIRST is the keeper, the later
      # identical copy drops its payload and points back. (A read with identical
      # results is handled by stale-collapse instead; see the read tests.)
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["mix", "test"]}, "0 failures")]),
        node(1, sees: [see("sh", %{"argv" => ["mix", "test"]}, "0 failures")])
      ]

      reduced = Reduce.lossless(slice)
      [keeper] = Enum.at(reduced, 0).sees
      [dup] = Enum.at(reduced, 1).sees

      assert keeper[:result] == "0 failures" or keeper["result"] == "0 failures"
      refute Map.has_key?(dup, :result)
      refute Map.has_key?(dup, "result")
      assert dup["cse_ref"] == "n0"
    end

    test "two identical-result READ calls are stale-collapsed (earlier dropped, last kept)" do
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["ls"]}, "OUT")]),
        node(1, sees: [see("sh", %{"argv" => ["ls"]}, "OUT")])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      [b] = Enum.at(reduced, 1).sees
      # the earlier read is staled (recoverable: identical bytes live on the last),
      # the last keeps its result.
      assert a["stale"] == true
      assert (b[:result] || b["result"]) == "OUT"
    end

    test "an external call (date) with different results is NEVER collapsed (effect-soundness)" do
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["date"]}, "T1")]),
        node(1, sees: [see("sh", %{"argv" => ["date"]}, "T2")])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      [b] = Enum.at(reduced, 1).sees
      # date is :external -> not stale-collapsed, results differ -> not CSE'd.
      assert (a[:result] || a["result"]) == "T1"
      assert (b[:result] || b["result"]) == "T2"
      refute Map.has_key?(a, "stale")
      refute Map.has_key?(b, "cse_ref")
    end
  end

  describe "errors are exempt" do
    test "a duplicated FAILED tool call is never collapsed or stripped" do
      slice = [
        node(0, sees: [see("x", %{}, %{"err" => "boom"})]),
        node(1, sees: [see("x", %{}, %{"err" => "boom"})])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      [b] = Enum.at(reduced, 1).sees
      # both keep their error result; neither is cse'd or staled.
      assert (a[:result] || a["result"]) == %{"err" => "boom"}
      assert (b[:result] || b["result"]) == %{"err" => "boom"}
      refute Map.has_key?(b, "cse_ref")
      refute Map.has_key?(b, "stale")
    end
  end

  describe "stale-read-collapse" do
    test "an earlier ok read (sh cat) is staled when a later read supersedes it" do
      # same read command+args, DIFFERENT results (file changed) -> not CSE, but
      # stale-collapsible because `cat` classifies :read: the earlier payload
      # drops, the last keeps its result.
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v1")]),
        node(1, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v2")])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      [b] = Enum.at(reduced, 1).sees
      # earlier read staled (payload dropped), later read kept.
      assert a["stale"] == true
      refute Map.has_key?(a, :result)
      assert (b[:result] || b["result"]) == "v2"
    end

    test "a mutation (sh rm) with different results is NOT stale-collapsed (effect-soundness)" do
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["rm", "f"]}, "ok1")]),
        node(1, sees: [see("sh", %{"argv" => ["rm", "f"]}, "ok2")])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      refute Map.has_key?(a, "stale")
      assert (a[:result] || a["result"]) == "ok1"
    end
  end

  describe "print-prune" do
    test "prints are dropped from the reduced nodes" do
      slice = [node(0, binds: %{x: 1}, prints: ["a", "b"], form: {:def, :x, {:literal, 1}, %{}})]
      reduced = Reduce.lossless(slice)
      assert Enum.at(reduced, 0).prints == []
    end
  end

  describe "S4 swarm regressions" do
    test "the cse/stale interaction keeps the last read recoverable (v1 v2 v1)" do
      # n0=v1, n1=v2, n2=v1 over the same read. The last read (n2) returns v1; the
      # reduced tape must keep v1 recoverable. (Running cse before stale dropped it.)
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v1")]),
        node(1, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v2")]),
        node(2, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v1")])
      ]

      reduced = Reduce.lossless(slice)
      # The last read keeps its actual result; it is not a dangling ref.
      [c] = Enum.at(reduced, 2).sees
      assert (c[:result] || c["result"]) == "v1"
      refute Map.has_key?(c, "cse_ref")
    end

    test "an sh-pipe with a mutating stage (tee) is NOT stale-collapsed" do
      slice = [
        node(0, sees: [see("sh-pipe", %{"stages" => [["cat", "s"], ["tee", "d"]]}, "old")]),
        node(1, sees: [see("sh-pipe", %{"stages" => [["cat", "s"], ["tee", "d"]]}, "new")])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      refute Map.has_key?(a, "stale")
      assert (a[:result] || a["result"]) == "old"
    end

    test "find with -delete is a mutation, not a collapsible read" do
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["find", "tmp", "-delete"]}, %{"lines" => ["tmp/x"]})]),
        node(1, sees: [see("sh", %{"argv" => ["find", "tmp", "-delete"]}, %{"lines" => []})])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      # the first result (evidence tmp/x existed) must survive.
      refute Map.has_key?(a, "stale")
      assert (a[:result] || a["result"]) == %{"lines" => ["tmp/x"]}
    end

    test "a false result is distinct from a nil result (presence-aware CSE key)" do
      # Use a :check call (not stale-collapsible) so this isolates tool-cse: false
      # and nil are DIFFERENT results and must not share a CSE key.
      slice = [
        node(0, sees: [%{name: "sh", args: %{"argv" => ["mix", "test"]}, result: false}]),
        node(1, sees: [%{name: "sh", args: %{"argv" => ["mix", "test"]}, result: nil}])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      [b] = Enum.at(reduced, 1).sees
      # distinct results -> not CSE'd; the false result survives, nil is not a ref.
      assert Map.fetch(a, :result) == {:ok, false}
      refute Map.has_key?(b, "cse_ref")
    end
  end

  describe "L2: world-epoch barrier" do
    test "a read is NOT stale-collapsed across an intervening write to the same path" do
      # cat f (v1) -> edit f (write) -> cat f (v2): both reads are load-bearing
      # (the agent compared pre- and post-edit state), so v1 must survive.
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v1")]),
        node(1, sees: [see("edit", %{"path" => "f"}, "applied")]),
        node(2, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v2")])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      # the pre-write read kept its result (not staled across the edit).
      refute Map.has_key?(a, "stale")
      assert (a[:result] || a["result"]) == "v1"
    end

    test "reads in the SAME epoch (no intervening write) still collapse" do
      # two cat f with NO write between -> the earlier is stale (same epoch).
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v1")]),
        node(1, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v2")])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      assert a["stale"] == true
    end

    test "an env-wrapped mutation (env rm f) barriers a read of f" do
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v1")]),
        node(1, sees: [see("sh", %{"argv" => ["env", "rm", "f"]}, "")]),
        node(2, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v2")])
      ]

      [a | _] = Enum.at(Reduce.lossless(slice), 0).sees
      refute Map.has_key?(a, "stale")
    end

    test "a native :path write barriers a native :target read of the same path" do
      slice = [
        node(0, sees: [%{name: "find", args: %{"target" => "f"}, result: "v1"}]),
        node(1, sees: [%{name: "edit", args: %{"path" => "f"}, result: "applied"}]),
        node(2, sees: [%{name: "find", args: %{"target" => "f"}, result: "v2"}])
      ]

      [a | _] = Enum.at(Reduce.lossless(slice), 0).sees
      refute Map.has_key?(a, "stale")
    end

    test "an unlocalizable write (nil path) is a GLOBAL barrier (define-tool)" do
      # list-tools (read) -> define-tool (mutation, no path) -> list-tools: the
      # registry changed, so the earlier snapshot must survive.
      slice = [
        node(0, sees: [%{name: "list-tools", args: %{}, result: "v1"}]),
        node(1, sees: [%{name: "define-tool", args: %{"name" => "t"}, result: "ok"}]),
        node(2, sees: [%{name: "list-tools", args: %{}, result: "v2"}])
      ]

      [a | _] = Enum.at(Reduce.lossless(slice), 0).sees
      refute Map.has_key?(a, "stale")
    end

    test "a write to a DIFFERENT path does not protect a read" do
      # cat f, edit g, cat f: the write is to g, not f, so f's reads still collapse.
      slice = [
        node(0, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v1")]),
        node(1, sees: [see("edit", %{"path" => "g"}, "applied")]),
        node(2, sees: [see("sh", %{"argv" => ["cat", "f"]}, "v2")])
      ]

      reduced = Reduce.lossless(slice)
      [a] = Enum.at(reduced, 0).sees
      assert a["stale"] == true
    end
  end

  describe "determinism" do
    test "the same slice reduces identically every time" do
      slice = [
        node(0, binds: %{x: 1}, form: {:def, :x, {:literal, 1}, %{}}),
        node(1, binds: %{x: 2}, form: {:def, :x, {:literal, 2}, %{}}, sees: [see("sh", %{}, "o")]),
        node(2, sees: [see("sh", %{}, "o")])
      ]

      assert Reduce.lossless(slice) == Reduce.lossless(slice)
    end
  end
end
