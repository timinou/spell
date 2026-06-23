defmodule SpellAgent.ClockTest do
  @moduledoc """
  Contracts for the A2 self-wake scheduler (PLAN-014).

  Defends the agency keystone: a scheduled wake RE-ENTERS the runner (the
  synthetic-caller seam), wakes survive a scheduler restart by rehydrating from
  the store, repeats re-arm, cancel disarms, and the wake budget throttles a
  runaway schedule WITHOUT crashing. The runner is injected so no test touches the
  network — a fake runner messages the test pid on each fire.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Clock
  alias SpellAgent.Clock.Wake
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    # Each test gets a clean shared Memory store and its OWN named Clock with an
    # injected runner that reports fires to the test pid. A unique name keeps the
    # app-supervised Clock (if any) out of the way.
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)

    test_pid = self()
    runner = fn prompt, opts -> send(test_pid, {:fired, prompt, opts}) end
    {:ok, runner: runner, test_pid: test_pid}
  end

  defp start_clock(ctx, opts \\ []) do
    name = :"clock_#{System.unique_integer([:positive])}"

    pid =
      start_supervised!(
        {Clock, [name: name, store: Memory, runner: ctx.runner] ++ opts},
        id: name
      )

    {pid, name}
  end

  describe "scheduling + firing" do
    test "a one-shot wake fires the runner with its prompt + session", ctx do
      {_pid, clock} = start_clock(ctx)

      %{"ok" => true, "id" => id} =
        Clock.at(%{"in" => 20, "prompt" => "advance goal", "session_id" => "sess-A"}, clock)

      assert is_binary(id)
      assert_receive {:fired, "advance goal", opts}, 500
      assert opts[:session_id] == "sess-A"
    end

    test "a missing prompt is rejected as an error, not scheduled", ctx do
      {_pid, clock} = start_clock(ctx)
      assert %{"err" => msg} = Clock.at(%{"in" => 10}, clock)
      assert msg =~ "prompt"
      refute_receive {:fired, _, _}, 100
    end

    test "a wake with neither :in nor :at nor :every is rejected", ctx do
      {_pid, clock} = start_clock(ctx)
      assert %{"err" => msg} = Clock.at(%{"prompt" => "x"}, clock)
      assert msg =~ ":in"
    end

    test "budget threads turns/cost_ceiling into the run opts", ctx do
      {_pid, clock} = start_clock(ctx)

      Clock.at(
        %{"in" => 20, "prompt" => "deep", "budget" => %{"turns" => 40, "cost_ceiling" => 2.0}},
        clock
      )

      assert_receive {:fired, "deep", opts}, 500
      assert opts[:max_turns] == 40
      assert opts[:cost_ceiling] == 2.0
    end

    test "a one-shot is removed from the store after it fires", ctx do
      {_pid, clock} = start_clock(ctx)
      %{"id" => id} = Clock.at(%{"in" => 10, "prompt" => "once"}, clock)

      assert_receive {:fired, "once", _}, 500
      # Give the post-fire forget() a moment to delete the store record.
      Process.sleep(30)
      assert :error = Store.fetch(Memory, {:clock, id})
    end
  end

  describe "repeat" do
    test "every/2 re-arms and fires repeatedly", ctx do
      {_pid, clock} = start_clock(ctx)
      %{"ok" => true} = Clock.every(%{"every" => 20, "prompt" => "tick"}, clock)

      assert_receive {:fired, "tick", _}, 500
      assert_receive {:fired, "tick", _}, 500
      assert_receive {:fired, "tick", _}, 500
    end

    test "a repeat survives in the store across fires (re-armed, not forgotten)", ctx do
      {_pid, clock} = start_clock(ctx)
      %{"id" => id} = Clock.every(%{"every" => 20, "prompt" => "tick"}, clock)

      assert_receive {:fired, "tick", _}, 500
      Process.sleep(30)
      assert {:ok, %Wake{repeat_ms: 20}} = Store.fetch(Memory, {:clock, id})
    end
  end

  describe "cancel" do
    test "cancel disarms a pending wake before it fires", ctx do
      {_pid, clock} = start_clock(ctx)
      %{"id" => id} = Clock.at(%{"in" => 200, "prompt" => "no"}, clock)

      assert %{"ok" => true} = Clock.cancel(id, clock)
      refute_receive {:fired, "no", _}, 350
      assert :error = Store.fetch(Memory, {:clock, id})
    end

    test "cancel is idempotent on an unknown id", ctx do
      {_pid, clock} = start_clock(ctx)
      assert %{"ok" => true} = Clock.cancel("wake-ghost", clock)
    end
  end

  describe "durability / rehydrate" do
    test "a wake persisted before boot rehydrates and fires on a fresh scheduler", ctx do
      # Simulate a wake that outlived its scheduler: write it straight to the
      # store with a fire time in the near future, then boot a NEW Clock. Boot
      # must reload + arm it.
      future = System.system_time(:millisecond) + 30

      wake = %Wake{
        id: "wake-rehydrate",
        fire_at_ms: future,
        session_id: "sess-R",
        prompt: "resumed goal"
      }

      Store.put(Memory, {:clock, "wake-rehydrate"}, wake)

      {_pid, _clock} = start_clock(ctx)

      assert_receive {:fired, "resumed goal", opts}, 1000
      assert opts[:session_id] == "sess-R"
    end

    test "an OVERDUE wake (fire_at in the past) fires promptly after rehydrate", ctx do
      past = System.system_time(:millisecond) - 10_000

      Store.put(Memory, {:clock, "wake-overdue"}, %Wake{
        id: "wake-overdue",
        fire_at_ms: past,
        session_id: "sess-O",
        prompt: "overdue"
      })

      {_pid, _clock} = start_clock(ctx)
      assert_receive {:fired, "overdue", _}, 1000
    end
  end

  describe "wake budget (the safety organ)" do
    test "a runaway repeat is throttled to the budget cap and never crashes", ctx do
      # Cap at 3 fires per a wide window, then hammer with a 5ms repeat. The
      # scheduler must fire up to the cap, drop the rest, stay alive, and report
      # the drops via pending/0.
      {pid, clock} = start_clock(ctx, max_wakes: 3, window_ms: 10_000)

      Clock.every(%{"every" => 5, "prompt" => "storm"}, clock)

      # Collect fires for a while; with a 5ms repeat and a cap of 3 we expect
      # exactly 3 deliveries then silence.
      fires = drain_fires(0)
      assert fires == 3, "expected budget cap of 3 fires, got #{fires}"

      assert Process.alive?(pid), "scheduler must survive a throttled storm"

      %{"dropped" => dropped, "fired" => fired} = Clock.pending(clock)
      assert fired == 3
      assert dropped >= 1
    end

    test "pending/0 lists scheduled wakes with telemetry", ctx do
      {_pid, clock} = start_clock(ctx)
      Clock.at(%{"in" => 5_000, "prompt" => "later"}, clock)

      %{"wakes" => wakes, "dropped" => 0, "fired" => 0} = Clock.pending(clock)
      assert [%{"prompt" => "later", "repeating" => false}] = wakes
    end
  end

  describe "parse_duration/1" do
    test "accepts integers (ms) and unit strings" do
      assert {:ok, 500} = Clock.parse_duration(500)
      assert {:ok, 500} = Clock.parse_duration("500ms")
      assert {:ok, 90_000} = Clock.parse_duration("90s")
      assert {:ok, 600_000} = Clock.parse_duration("10m")
      assert {:ok, 7_200_000} = Clock.parse_duration("2h")
      assert {:ok, 86_400_000} = Clock.parse_duration("1d")
      assert {:ok, 42} = Clock.parse_duration("42")
    end

    test "rejects garbage + negatives" do
      assert :error = Clock.parse_duration(-1)
      assert :error = Clock.parse_duration("soon")
      assert :error = Clock.parse_duration(nil)
    end
  end

  # Count :fired messages until a quiet gap (no fire within 120ms ends the drain).
  defp drain_fires(count) do
    receive do
      {:fired, _, _} -> drain_fires(count + 1)
    after
      120 -> count
    end
  end
end
