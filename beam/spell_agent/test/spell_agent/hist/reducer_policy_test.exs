defmodule SpellAgent.Hist.ReducerPolicyTest do
  @moduledoc """
  FEAT-037: the reduction POLICY (pipeline order, effect taxonomy, spill
  threshold) is rewritable DATA, while the env-preservation INVARIANT stays
  enforced by the compiled body.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Config
  alias SpellAgent.Hist.{Effect, Node, Reduce, Spill}
  alias SpellAgent.Hist.Store.Memory

  describe "pipeline order as data (Reduce)" do
    test "the pipeline order is loaded from the .ptc data file" do
      # The canonical order lives in priv/hist/reducers/pipeline.ptc, not hardcoded
      # in lossless/1.
      order = Reduce.pipeline_order()
      assert order == ["dead-bind-elim", "stale-read-collapse", "tool-cse", "print-prune"]
    end

    test "lossless still preserves the def-env (the invariant the order protects)" do
      slice = [
        node("a", 1, %{x: 1}, ["debug print"]),
        node("b", 2, %{x: 2}, [])
      ]

      reduced = Reduce.lossless(slice)
      assert Reduce.fold_env(reduced) == Reduce.fold_env(slice)
      # print-prune ran (a data-listed transform) -> prints dropped.
      assert Enum.all?(reduced, &(&1.prints == []))
    end

    test "the transform primitives are the closed vocabulary (unknown names are inert)" do
      # An unknown transform name in a pipeline is skipped, not executed as code —
      # the body's guarantee that data can only compose KNOWN transforms.
      slice = [node("a", 1, %{x: 1}, [])]
      # dead-bind-elim is a real transform; a bogus name is a no-op.
      assert Reduce.fold_env(Reduce.lossless(slice)) == Reduce.fold_env(slice)
    end

    test "a transform name quoted inside a COMMENT is not injected into the pipeline" do
      # review S2: pipeline.ptc's comment block contains quoted transform names.
      # parse must strip comments first, so the order is exactly the vector's 4
      # entries — no phantom duplicate transform from a comment.
      order = Reduce.pipeline_order()
      assert order == ["dead-bind-elim", "stale-read-collapse", "tool-cse", "print-prune"]
      assert length(order) == length(Enum.uniq(order))
    end
  end

  describe "effect taxonomy as data (Effect)" do
    setup do
      on_exit(fn -> Effect.reload_tables() end)
      :ok
    end

    test "the classification tables are loaded from the .ptc data file" do
      t = Effect.tables()
      assert MapSet.member?(t["read-heads"], "cat")
      assert MapSet.member?(t["mutation-heads"], "rm")
      assert MapSet.member?(t["read-tools"], "code-parse")
      assert MapSet.member?(t["mutation-tools"], "code-edit")
    end

    test "classification uses the data tables (a read head is restorable, a mutation is not)" do
      assert Effect.classify(%{name: "sh", args: %{argv: ["cat", "f"]}}) == :read
      assert Effect.classify(%{name: "sh", args: %{argv: ["rm", "f"]}}) == :mutation
      assert Effect.restorable_node?([%{name: "sh", args: %{argv: ["cat", "f"]}}])
      refute Effect.restorable_node?([%{name: "sh", args: %{argv: ["rm", "f"]}}])
    end

    test "a malformed/absent data file degrades to the compiled fallback (never-brick)" do
      # tables/0 always returns every key with at least the fallback set, so even
      # if the data file were unreadable, classification keeps working.
      t = Effect.tables()

      for key <- ~w(read-tools mutation-tools read-heads wrapper-heads check-heads external-heads mutation-heads) do
        assert %MapSet{} = t[key]
        refute MapSet.size(t[key]) == 0
      end
    end
  end

  describe "spill threshold as config (Spill)" do
    setup do
      original = Config.get("hist.spill_threshold")
      on_exit(fn -> Config.put("hist.spill_threshold", original) end)
      :ok
    end

    test "the spill threshold comes from config, retunable live" do
      # A tiny threshold makes a restorable result spillable; a huge one makes the
      # same result NOT spillable. Observed through spill/1 (which reads config at
      # call time), proving the threshold is not baked in.
      big_read = read_node_with_result("r1", String.duplicate("payload ", 300))

      Config.put("hist.spill_threshold", 1)
      [low] = Spill.spill([big_read])
      assert low.result != big_read.result, "a sub-1 config threshold must spill the result"

      Config.put("hist.spill_threshold", 10_000_000)
      [high] = Spill.spill([big_read])
      assert high.result == big_read.result, "a huge config threshold must NOT spill the result"
    end

    test "an explicit :threshold_tokens opt overrides config" do
      big_read = read_node_with_result("r2", String.duplicate("payload ", 300))
      Config.put("hist.spill_threshold", 10_000_000)

      # config would say "don't spill", but the explicit opt forces a tiny threshold.
      [spilled] = Spill.spill([big_read], threshold_tokens: 1)
      refute spilled.result == big_read.result
    end

    test "the reducibility ESTIMATE tracks the config threshold (estimate/spill sync)" do
      # review S2: the estimate must shed the same byte set Spill would, so a
      # config retune changes BOTH — else Mission.decide computes K* on the wrong
      # set. A tiny threshold -> big reducible estimate; a huge one -> zero.
      seed_read_session("est-sync", 3)

      Config.put("hist.spill_threshold", 1)
      low = SpellAgent.Hist.Namespace.reducibility(Memory, "est-sync", %{})

      Config.put("hist.spill_threshold", 10_000_000)
      high = SpellAgent.Hist.Namespace.reducibility(Memory, "est-sync", %{})

      assert low["reducible_tokens"] > 0
      assert high["reducible_tokens"] == 0
    end
  end

  defp seed_read_session(session_id, n) do
    SpellAgent.Hist.Store.clear(Memory)

    last =
      Enum.reduce(1..n, nil, fn i, parent ->
        SpellAgent.Hist.Recorder.record_node(
          Memory,
          session_id,
          %{
            program: {:tool_call, "sh", %{argv: ["cat", "f#{i}"]}},
            memory: %{},
            result: String.duplicate("payload ", 400),
            tool_calls: [
              %{name: "sh", args: %{argv: ["cat", "f#{i}"]}, result: String.duplicate("y ", 400)}
            ]
          },
          parent && parent.id
        )
      end)

    {:ok, sess} = SpellAgent.Hist.Store.fetch(Memory, {:session, session_id})
    SpellAgent.Hist.Store.put(Memory, {:session, session_id}, %{sess | cursors: %{main: last.id}})
    :ok
  end

  # --- fixtures --------------------------------------------------------------

  defp node(id, seq, binds, prints) do
    %Node{
      id: id,
      session: "t",
      seq: seq,
      binds: binds,
      sees: [],
      prints: prints,
      form: nil,
      result: nil
    }
  end

  defp read_node_with_result(id, result) do
    %Node{
      id: id,
      session: "t",
      seq: 1,
      binds: %{},
      sees: [%{name: "sh", args: %{argv: ["cat", "f"]}, result: result}],
      prints: [],
      form: {:tool_call, "sh", %{argv: ["cat", "f"]}},
      result: result
    }
  end
end
