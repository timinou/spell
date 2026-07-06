defmodule SpellAgent.Hist.RateControllerTest do
  use ExUnit.Case, async: false

  alias SpellAgent.Config
  alias SpellAgent.Hist.{Namespace, RateController, Recorder, Store}
  alias SpellAgent.Hist.Store.Memory

  # Record a session with `n` def turns, each binding a distinct symbol to a big
  # string — enough reducible content that a low window ceiling forces a reduce.
  defp seed_session(session_id, n) do
    Store.clear(Memory)

    last =
      Enum.reduce(1..n, nil, fn i, parent ->
        # A `sh` call with a READ head (cat) + a BIG result: Effect classifies it
        # :read -> restorable, and the >2KB result is well over the ~512-token
        # spill threshold, so the lossy tier can shed it. This is what makes the
        # reducibility estimate report reducible_tokens > 0 (the precondition for a
        # reduce decision).
        Recorder.record_node(
          Memory,
          session_id,
          %{
            program: {:tool_call, "sh", %{argv: ["cat", "f#{i}"]}},
            memory: %{},
            result: String.duplicate("BIGRESULT-#{i} ", 3000),
            tool_calls: [
              %{name: "sh", args: %{argv: ["cat", "f#{i}"]}, result: String.duplicate("line ", 3000)}
            ]
          },
          parent && parent.id
        )
      end)

    {:ok, sess} = Store.fetch(Memory, {:session, session_id})
    Store.put(Memory, {:session, session_id}, %{sess | cursors: %{main: last.id}})
    :ok
  end

  setup do
    # Snapshot + restore the config keys this test flips.
    soft = Config.get("hist.window_soft")
    hard = Config.get("hist.window_hard")
    auto = Config.get("hist.auto_reduce")

    on_exit(fn ->
      Config.put("hist.window_soft", soft)
      Config.put("hist.window_hard", hard)
      Config.put("hist.auto_reduce", auto)
    end)

    :ok
  end

  describe "safe no-op paths (never brick a mission)" do
    test "auto_reduce disabled -> always caches the verbatim tape" do
      Config.put("hist.auto_reduce", false)
      tape = [%{role: :user, content: "hi"}]

      out = RateController.run(Memory, "rc-off", tape, 12)
      assert out.decision == :cache
      refute out.reduced?
      assert out.tape == tape
    end

    test "an empty (cold-start) tape caches" do
      Config.put("hist.auto_reduce", true)
      out = RateController.run(Memory, "rc-empty", [], 12)
      assert out.decision == :cache
      refute out.reduced?
    end

    test "a session with no reducible pressure caches (tape preserved)" do
      Config.put("hist.auto_reduce", true)
      Config.put("hist.window_soft", 120_000)
      Config.put("hist.window_hard", 170_000)
      tape = [%{role: :user, content: "small"}]

      out = RateController.run(Memory, "rc-nopressure", tape, 12)
      assert out.decision == :cache
      assert out.tape == tape
    end
  end

  describe "activation under pressure (FEAT-036 — the dormant engine goes live)" do
    test "a low window ceiling forces a reduce and the controller applies it" do
      session_id = "rc-pressure"
      seed_session(session_id, 6)
      Config.put("hist.auto_reduce", true)
      # Drive the soft ceiling BELOW the recorded tape's estimate so the ladder's
      # soft-overflow rung fires (and there is reducible content to shed).
      Config.put("hist.window_soft", 1)
      Config.put("hist.window_hard", 1_000_000)

      # The REALISTIC verbatim tape is the full (unreduced) refold of the recorded
      # slice — what Hist.continuation would carry. The controller only accepts the
      # reduced tape if it is a GENUINE shrink over this (review S2 P1 guard), so
      # the test must compare against the real full tape, not a tiny placeholder.
      {:ok, %{nodes: slice}} = SpellAgent.Hist.Reconstitute.at(Memory, session_id, :main)
      verbatim = SpellAgent.Hist.Refold.slice_to_tape(slice)

      out = RateController.run(Memory, session_id, verbatim, 12)

      assert match?({:reduce, _tier}, out.decision),
             "expected a reduce decision under a sub-1 soft ceiling, got #{inspect(out.decision)}"

      # A reduce that genuinely shrinks the tape swaps in the reduced refold.
      assert out.reduced?
      assert is_list(out.tape)
      assert :erlang.external_size(out.tape) < :erlang.external_size(verbatim),
             "the reduced tape must be strictly smaller than the verbatim tape"
    end

    test "a reduce that yields no usable tape falls back to the verbatim tape" do
      # No recorded session for this id -> reduce returns an {"err" ...} map, so the
      # controller must keep the verbatim tape (best-effort, never brick).
      Config.put("hist.auto_reduce", true)
      Config.put("hist.window_soft", 1)

      verbatim = [%{role: :user, content: "keepme"}]
      out = RateController.run(Memory, "rc-noreduce-#{System.unique_integer([:positive])}", verbatim, 12)

      # decision may be reduce, but the apply falls back -> tape unchanged.
      assert out.tape == verbatim
      refute out.reduced?
    end
  end
end
