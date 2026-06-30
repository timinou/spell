defmodule SpellAgent.Clock.NamespaceTest do
  @moduledoc """
  Contracts for the `clock/*` PTC verb surface (PLAN-014, wave 3).

  Defends what the agent actually touches: the verb map shapes args correctly,
  defaults a wake to the CALLING session, schedules through to a real (injected)
  Clock, reports a clear error for a bad arg, and degrades to an error — never a
  crash — when the scheduler is not running.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Clock
  alias SpellAgent.Clock.Namespace
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)

    test_pid = self()
    runner = fn prompt, opts -> send(test_pid, {:fired, prompt, opts}) end

    name = :"clock_ns_#{System.unique_integer([:positive])}"
    start_supervised!({Clock, [name: name, store: Memory, runner: runner]}, id: name)

    verbs = Namespace.tools("sess-caller", name)
    {:ok, verbs: verbs, clock: name}
  end

  test "clock/at schedules a one-shot that fires in the calling session", %{verbs: verbs} do
    assert %{"ok" => true, "id" => id} = verbs["clock/at"].(%{"in" => 20, "prompt" => "go"})
    assert is_binary(id)
    assert_receive {:fired, "go", opts}, 500
    assert opts[:session_id] == "sess-caller"
  end

  test "clock/at respects an explicit session_id override", %{verbs: verbs} do
    verbs["clock/at"].(%{"in" => 20, "prompt" => "go", "session_id" => "other"})
    assert_receive {:fired, "go", opts}, 500
    assert opts[:session_id] == "other"
  end

  test "clock/every schedules a repeat", %{verbs: verbs} do
    assert %{"ok" => true} = verbs["clock/every"].(%{"every" => 20, "prompt" => "tick"})
    assert_receive {:fired, "tick", _}, 500
    assert_receive {:fired, "tick", _}, 500
  end

  test "clock/every without :every is a clear error", %{verbs: verbs} do
    assert %{"err" => msg} = verbs["clock/every"].(%{"prompt" => "x"})
    assert msg =~ "every"
  end

  test "clock/cancel removes a scheduled wake", %{verbs: verbs} do
    %{"id" => id} = verbs["clock/at"].(%{"in" => 500, "prompt" => "no"})
    assert %{"ok" => true} = verbs["clock/cancel"].(%{"id" => id})
    refute_receive {:fired, "no", _}, 250
  end

  test "clock/cancel without :id is a clear error", %{verbs: verbs} do
    assert %{"err" => msg} = verbs["clock/cancel"].(%{})
    assert msg =~ ":id"
  end

  test "clock/pending lists scheduled wakes + telemetry", %{verbs: verbs} do
    verbs["clock/at"].(%{"in" => 5_000, "prompt" => "later"})
    assert %{"wakes" => [%{"prompt" => "later"}], "dropped" => 0, "fired" => 0} =
             verbs["clock/pending"].(%{})
  end

  test "duration strings are accepted through the verb", %{verbs: verbs, clock: clock} do
    before = System.system_time(:millisecond)
    %{"ok" => true, "fire_at" => fire_at} = verbs["clock/at"].(%{"in" => "1h", "prompt" => "much later"})
    # ~1h out (3_600_000ms), well beyond a few ms of scheduling slack.
    assert fire_at - before > 3_500_000
    # And it is genuinely pending on the real scheduler.
    assert %{"wakes" => [_]} = Clock.pending(clock)
  end

  test "verbs degrade to an error (never crash) when the scheduler is down" do
    verbs = Namespace.tools("sess-x", :"clock_absent_#{System.unique_integer([:positive])}")
    assert %{"err" => msg} = verbs["clock/at"].(%{"in" => 10, "prompt" => "x"})
    assert msg =~ "not running"
    assert %{"err" => _} = verbs["clock/pending"].(%{})
  end

  # FUP-019: the namespace STAMPS the scheduling session's capability ceiling
  # (:allowed) + region into the wake, server-side, from the closure-captured
  # opts. An ATTENUATED child gets a clock surface whose wakes carry its ceiling,
  # and the mind cannot widen it: a `__allowed` value in the agent's own args is
  # OVERWRITTEN by the stamp. This is the security contract — the re-entry analogue
  # of the spawn-seam clamp (BUG-017).
  describe "capability ceiling stamp (FUP-019)" do
    setup do
      test_pid = self()
      runner = fn prompt, opts -> send(test_pid, {:fired, prompt, opts}) end
      name = :"clock_cap_#{System.unique_integer([:positive])}"
      start_supervised!({Clock, [name: name, store: Memory, runner: runner]}, id: name)
      {:ok, clock: name}
    end

    test "an attenuated session's clock verbs stamp its allowed-list onto the wake", %{clock: clock} do
      # The session was handed a ["find"] base ceiling (what Session.build_session_tools
      # passes for an attenuated child). Its wake must fire with :tools = ["find"].
      verbs = Namespace.tools("sess-child", clock, allowed: ["find"])
      verbs["clock/at"].(%{"in" => 20, "prompt" => "narrow"})

      assert_receive {:fired, "narrow", opts}, 500
      assert opts[:tools] == ["find"]
    end

    test "the root's :all ceiling stamps no :tools (full base surface)", %{clock: clock} do
      verbs = Namespace.tools("sess-root", clock, allowed: :all)
      verbs["clock/at"].(%{"in" => 20, "prompt" => "wide"})

      assert_receive {:fired, "wide", opts}, 500
      refute Keyword.has_key?(opts, :tools)
    end

    test "the mind CANNOT widen its ceiling by supplying its own __allowed", %{clock: clock} do
      # A malicious/confused attenuated child tries to grant itself the full
      # surface by passing __allowed: :all in its OWN args. The server-side stamp
      # must OVERWRITE it with the real ceiling (["find"]).
      verbs = Namespace.tools("sess-evil", clock, allowed: ["find"])
      verbs["clock/at"].(%{"in" => 20, "prompt" => "escape", "__allowed" => :all})

      assert_receive {:fired, "escape", opts}, 500
      assert opts[:tools] == ["find"]
    end

    test "the scheduling session's region is stamped onto the wake", %{clock: clock} do
      verbs = Namespace.tools("sess-rg", clock, allowed: ["find"], region: "region-X")
      verbs["clock/at"].(%{"in" => 20, "prompt" => "coord"})

      assert_receive {:fired, "coord", opts}, 500
      assert opts[:region] == "region-X"
    end

    test "clock/pending surfaces the wake's allowed ceiling for telemetry", %{clock: clock} do
      verbs = Namespace.tools("sess-tel", clock, allowed: ["find"])
      verbs["clock/at"].(%{"in" => 5_000, "prompt" => "pending"})

      assert %{"wakes" => [%{"allowed" => ["find"]}]} = verbs["clock/pending"].(%{})
    end
  end
end
