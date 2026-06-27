defmodule SpellAgent.Mesh.WatcherTest do
  @moduledoc """
  M3 (FEAT-013) contracts ON TOP of the single-node condition-fuse (FEAT-021,
  covered by watch_test.exs): fuel-bounded cascades and exactly-once firing.

  Drives a named Watcher + a real Clock with a fake runner (zero network), the
  same harness watch_test uses. The Watcher fires through Clock; the runner
  forwards each wake to the test process, so a fire is observable as a {:woke, ...}
  message and we can COUNT fires.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Clock
  alias SpellAgent.Mesh.Namespace
  alias SpellAgent.Mesh.Store, as: MeshStore
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)

    test_pid = self()
    runner = fn prompt, opts -> send(test_pid, {:woke, prompt, opts}) end

    clock_name = :"watcher_clock_#{System.unique_integer([:positive])}"
    start_supervised!({Clock, [name: clock_name, store: Memory, runner: runner]}, id: clock_name)

    watcher_name = :"watcher_#{System.unique_integer([:positive])}"

    start_supervised!(
      {SpellAgent.Mesh.Watcher,
       [name: watcher_name, store: Memory, clock: clock_name, enabled: true]},
      id: watcher_name
    )

    region = "region-#{System.unique_integer([:positive])}"
    verbs = Namespace.tools(Memory, "sess-w", region)
    {:ok, verbs: verbs, region: region}
  end

  # Count {:woke, _, _} messages arriving within a window.
  defp count_wakes(acc \\ 0) do
    receive do
      {:woke, _, _} -> count_wakes(acc + 1)
    after
      300 -> acc
    end
  end

  describe "fuel-bounded firing" do
    test "a :once watch (default) fires exactly once, then retires", %{verbs: verbs, region: region} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding"},
        "wake" => %{"prompt" => "once"}
      })

      # Two matching posts; only the FIRST fires (the intention retires after).
      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 1}})
      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 2}})

      assert count_wakes() == 1
      # The intention retired (deleted) after firing.
      assert MeshStore.by_kind(Memory, region, :intention) == []
    end

    test "a :fuel N watch fires up to N times, then retires", %{verbs: verbs, region: region} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding"},
        "wake" => %{"prompt" => "fueled"},
        "once" => false,
        "fuel" => 2
      })

      # Three matching posts; fuel 2 caps fires at 2.
      for n <- 1..3 do
        verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => n}})
      end

      assert count_wakes() == 2
      # Fuel spent -> intention retired.
      assert MeshStore.by_kind(Memory, region, :intention) == []
    end

    test "a self-retriggering watch burns fuel and halts (PT-1)", %{verbs: verbs, region: region} do
      # A watch whose :do would re-post is approximated here: each matching post is
      # itself a finding, and the watch matches findings. We post once and rely on
      # fuel to bound; the cascade can't exceed fuel regardless of re-posts.
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding"},
        "wake" => %{"prompt" => "cascade"},
        "once" => false,
        "fuel" => 3
      })

      for n <- 1..10 do
        verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => n}})
      end

      # Never more than fuel, no matter how many matching posts arrive.
      assert count_wakes() == 3
      assert MeshStore.by_kind(Memory, region, :intention) == []
    end
  end

  describe "exactly-once (claim-dedup, DC-6)" do
    test "the same observed post never double-fires one intention (local dedup)",
         %{verbs: verbs, region: region} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding"},
        "wake" => %{"prompt" => "dedup"},
        "once" => false,
        "fuel" => 5
      })

      # One post. Even if the telemetry handler were to deliver twice, the
      # (intention_seq, event_seq) local-done set ensures a single fire.
      assert %{"id" => _} = verbs["black/post"].(%{"kind" => "finding", "payload" => %{"x" => 1}})

      assert count_wakes() == 1
      # BUG-019: the firing dedup is a CONTROL key, NOT a mesh record — so it must
      # NOT pollute the region. No fire: claim record exists, and black/query sees
      # only the user's finding (never an internal fire-claim).
      claims = MeshStore.by_kind(Memory, region, :claim)
      refute Enum.any?(claims, fn c -> String.starts_with?(c.payload["work"] || "", "fire:") end)
      all = MeshStore.region(Memory, region)
      assert Enum.all?(all, fn r -> r.kind in [:finding, :intention] end)
    end

    test "a kindless once:false watch does NOT re-fire on its own dedup (no feedback loop)",
         %{verbs: verbs, region: region} do
      # The regression for BUG-019: a kindless/any-match watch must not observe an
      # internal firing record and re-trigger itself. One real post -> one fire,
      # not a fuel-burning cascade off its own dedup writes.
      verbs["black/watch"].(%{
        "when" => %{"count" => 1},
        "wake" => %{"prompt" => "loop?"},
        "once" => false,
        "fuel" => 5
      })

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"x" => 1}})

      # Exactly one fire — no self-triggered cascade burning the fuel down.
      assert count_wakes() == 1
      # The watch is still alive (fuel not burned out by a feedback loop).
      assert [_] = MeshStore.by_kind(Memory, region, :intention)
    end
  end

  describe "best-effort" do
    test "a watch with no matching post never fires", %{verbs: verbs} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding", "where" => %{"status" => "done"}},
        "wake" => %{"prompt" => "never"}
      })

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"status" => "pending"}})

      assert count_wakes() == 0
    end
  end
end
