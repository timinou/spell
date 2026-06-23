defmodule SpellAgent.Mesh.WatchTest do
  @moduledoc """
  Contracts for A3 — condition-fused self-wake on the blackboard (FEAT-021).

  Defends the full chain end-to-end: black/watch registers a durable :intention; a
  matching black/post is observed by the single-node Mesh.Watcher; the watcher
  fires an IMMEDIATE wake through the real Clock; the (injected) runner re-enters
  with the watch's prompt. The whole point — a single detonator (Clock), a
  condition fuse (the watcher) — is proven by routing fires through a real Clock
  with a fake runner, zero network.
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

    clock_name = :"watch_clock_#{System.unique_integer([:positive])}"
    start_supervised!({Clock, [name: clock_name, store: Memory, runner: runner]}, id: clock_name)

    watcher_name = :"watcher_#{System.unique_integer([:positive])}"

    start_supervised!(
      {SpellAgent.Mesh.Watcher,
       [name: watcher_name, store: Memory, clock: clock_name, enabled: true]},
      id: watcher_name
    )

    # A region this session holds write capability for. The verbs close over the
    # store, the calling session, and the region.
    region = "region-#{System.unique_integer([:positive])}"
    verbs = Namespace.tools(Memory, "sess-watcher", region)
    {:ok, verbs: verbs, region: region, clock: clock_name}
  end

  describe "registration" do
    test "black/watch persists a durable :intention record", %{verbs: verbs, region: region} do
      assert %{"id" => id, "region" => ^region} =
               verbs["black/watch"].(%{
                 "when" => %{"kind" => "finding", "where" => %{"status" => "done"}},
                 "wake" => %{"prompt" => "fold and decide"}
               })

      assert is_integer(id)
      assert [intention] = MeshStore.by_kind(Memory, region, :intention)
      assert intention.payload["wake"]["prompt"] == "fold and decide"
      # session_id defaults to the registering session
      assert intention.payload["wake"]["session_id"] == "sess-watcher"
    end

    test "a malformed :when is rejected, nothing persisted", %{verbs: verbs, region: region} do
      assert %{"err" => msg} = verbs["black/watch"].(%{"when" => "nope", "wake" => %{"prompt" => "x"}})
      assert msg =~ ":when"
      assert [] = MeshStore.by_kind(Memory, region, :intention)
    end

    test "a :wake without a prompt is rejected", %{verbs: verbs} do
      assert %{"err" => msg} =
               verbs["black/watch"].(%{"when" => %{"kind" => "finding"}, "wake" => %{}})

      assert msg =~ ":prompt"
    end
  end

  describe "firing (where-form)" do
    test "a matching post fires a wake with the watch's prompt", %{verbs: verbs} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding", "where" => %{"status" => "done"}},
        "wake" => %{"prompt" => "a sibling finished"}
      })

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"status" => "done"}})

      assert_receive {:woke, "a sibling finished", opts}, 1000
      assert opts[:session_id] == "sess-watcher"
    end

    test "a non-matching post does NOT fire", %{verbs: verbs} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding", "where" => %{"status" => "done"}},
        "wake" => %{"prompt" => "should not fire"}
      })

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"status" => "wip"}})
      refute_receive {:woke, _, _}, 300
    end

    test "the fire genuinely routes through the Clock (single detonator)", %{
      verbs: verbs,
      clock: clock
    } do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding"},
        "wake" => %{"prompt" => "via clock"}
      })

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"x" => 1}})

      assert_receive {:woke, "via clock", _}, 1000
      # The Clock recorded a fire — proof the wake went through A2, not a side path.
      assert %{"fired" => fired} = Clock.pending(clock)
      assert fired >= 1
    end
  end

  describe ":once semantics" do
    test "a :once watch (default) fires once then retires", %{verbs: verbs, region: region} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding"},
        "wake" => %{"prompt" => "once only"}
      })

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 1}})
      assert_receive {:woke, "once only", _}, 1000

      # the intention is retired after firing
      Process.sleep(50)
      assert [] = MeshStore.by_kind(Memory, region, :intention)

      # a second matching post does not re-fire
      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 2}})
      refute_receive {:woke, "once only", _}, 300
    end

    test "a :once false watch re-fires on each match", %{verbs: verbs} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding"},
        "wake" => %{"prompt" => "repeat"},
        "once" => false
      })

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 1}})
      assert_receive {:woke, "repeat", _}, 1000

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 2}})
      assert_receive {:woke, "repeat", _}, 1000
    end
  end

  describe "threshold (count) form" do
    test "fires only when N matching records exist", %{verbs: verbs} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding", "count" => 3},
        "wake" => %{"prompt" => "three are in"}
      })

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 1}})
      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 2}})
      refute_receive {:woke, "three are in", _}, 300

      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 3}})
      assert_receive {:woke, "three are in", _}, 1000
    end
  end

  describe "ttl expiry" do
    test "an expired intention does not fire and is dropped", %{verbs: verbs, region: region} do
      verbs["black/watch"].(%{
        "when" => %{"kind" => "finding"},
        "wake" => %{"prompt" => "too late"},
        "ttl_ms" => 1
      })

      # let the ttl lapse, then post a match
      Process.sleep(20)
      verbs["black/post"].(%{"kind" => "finding", "payload" => %{"n" => 1}})

      refute_receive {:woke, "too late", _}, 300
      Process.sleep(50)
      assert [] = MeshStore.by_kind(Memory, region, :intention)
    end
  end

  describe "best-effort posture" do
    test "black/watch persists even with no watcher running", %{region: region} do
      # A fresh region + verbs, but DON'T rely on the watcher firing — just prove
      # the intention is durable regardless (a watch is a monotone post).
      verbs = Namespace.tools(Memory, "sess-x", region)

      assert %{"id" => _} =
               verbs["black/watch"].(%{
                 "when" => %{"kind" => "finding"},
                 "wake" => %{"prompt" => "later"}
               })

      assert [_] = MeshStore.by_kind(Memory, region, :intention)
    end
  end
end
