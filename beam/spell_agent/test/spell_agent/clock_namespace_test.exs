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
end
