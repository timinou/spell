defmodule SpellAgent.SessionRegistryTest do
  @moduledoc """
  The live-session tracker (PLAN-010, C1): registration, the monitor-driven
  auto-cleanup that is the whole point (a crashed run leaves no stale "open"
  row), and the best-effort posture when the registry is down.

  The registry is the app-supervised singleton (named `SessionRegistry`), and the
  client API targets that fixed name, so these run against it directly. Each test
  uses a unique session id and stops its owner in teardown, so they don't
  cross-contaminate the shared process.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.SessionRegistry, as: Reg

  setup do
    ensure_registry()
    :ok
  end

  # Spawn a process that registers `session_id` and stays alive until told to
  # stop, so the registry's monitor has a live owner to watch.
  defp spawn_owner(session_id, meta) do
    parent = self()

    pid =
      spawn(fn ->
        Reg.register(session_id, meta)
        send(parent, :registered)
        receive do: (:stop -> :ok)
      end)

    receive do: (:registered -> :ok)
    pid
  end

  test "register surfaces a session as live with its meta" do
    owner = spawn_owner("t_meta", %{prompt: "do it", model: "m1"})

    assert Reg.live?("t_meta")
    entry = Enum.find(Reg.live(), &(&1.session_id == "t_meta"))
    assert %{prompt: "do it", model: "m1", pid: ^owner} = entry

    send(owner, :stop)
  end

  test "set_owner re-parents lineage in place, PRESERVING the monitored pid (PLAN-027 M6)" do
    owner = spawn_owner("t_adopt", %{prompt: "child work", owner: {:session, "parent-x"}, parent_id: "parent-x"})

    # Re-parent to :human WITHOUT re-registering (which would re-monitor the
    # caller, not `owner`). The pid must stay the original session pid.
    :ok = Reg.set_owner("t_adopt", :human, nil)

    entry = Enum.find(Reg.live(), &(&1.session_id == "t_adopt"))
    assert entry.owner == :human
    assert entry.parent_id == nil
    # The monitored pid is UNCHANGED (still the real session owner, not self()).
    assert entry.pid == owner
    refute entry.pid == self()

    send(owner, :stop)
  end

  test "set_owner on an unknown session is a no-op" do
    assert Reg.set_owner("never_registered", :human, nil) == :ok
    refute Reg.live?("never_registered")
  end

  test "finish removes a live session" do
    owner = spawn_owner("t_finish", %{})
    assert Reg.live?("t_finish")

    :ok = Reg.finish("t_finish")
    refute Reg.live?("t_finish")

    send(owner, :stop)
  end

  test "a crashed owner is auto-unregistered (monitor cleanup)" do
    owner = spawn_owner("t_crash", %{})
    assert Reg.live?("t_crash")

    Process.exit(owner, :kill)
    wait_until(fn -> not Reg.live?("t_crash") end)
  end

  test "a normally-exiting owner is auto-unregistered" do
    owner = spawn_owner("t_normal", %{})
    send(owner, :stop)
    wait_until(fn -> not Reg.live?("t_normal") end)
  end

  test "re-registering the same id replaces the entry and re-points the monitor" do
    old = spawn_owner("t_replace", %{prompt: "old"})
    new = spawn_owner("t_replace", %{prompt: "new"})

    entry = Enum.find(Reg.live(), &(&1.session_id == "t_replace"))
    assert %{prompt: "new", pid: ^new} = entry

    Process.exit(old, :kill)
    Process.sleep(30)
    assert Reg.live?("t_replace")

    send(new, :stop)
  end

  test "live/0 sorts most-recently-started first" do
    o1 = spawn_owner("t_sort_a", %{t0: 100})
    o2 = spawn_owner("t_sort_b", %{t0: 200})

    ids = Reg.live() |> Enum.map(& &1.session_id) |> Enum.filter(&(&1 in ["t_sort_a", "t_sort_b"]))
    assert ids == ["t_sort_b", "t_sort_a"]

    send(o1, :stop)
    send(o2, :stop)
  end

  test "client functions degrade to no-op / empty when the registry is down" do
    :ok = Supervisor.terminate_child(SpellAgent.Supervisor, Reg)
    on_exit(&ensure_registry/0)

    assert :ok = Reg.register("t_down", %{})
    assert :ok = Reg.finish("t_down")
    assert [] = Reg.live()
    refute Reg.live?("t_down")
  end

  # Restart the supervised child if a prior down-path test terminated it.
  defp ensure_registry do
    case Process.whereis(Reg) do
      nil -> Supervisor.restart_child(SpellAgent.Supervisor, Reg)
      _pid -> :ok
    end
  end

  defp wait_until(fun, tries \\ 50)
  defp wait_until(_fun, 0), do: flunk("condition not met in time")

  defp wait_until(fun, tries) do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      wait_until(fun, tries - 1)
    end
  end
end
