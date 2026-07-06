defmodule SpellAgent.Tui.CockpitTest do
  @moduledoc """
  PLAN-027 M0 / FEAT-046: the cockpit materializer `Cockpit.sessions/1` — the one
  new read-Elixir the multi-session cockpit needs. Defends its contract: the
  union of live registry lineage with per-session Hist content, the @max_sessions
  bound, the per-row never-brick, and the registry-down degrade. Also asserts the
  `install/0` periphery call registers exactly one query-clock data source
  (`data/sessions`) so the render loop never names the feature.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.Cockpit
  alias SpellAgent.Tui.DataSource.Registry, as: DataSources
  alias SpellAgent.SessionRegistry, as: Reg
  alias SpellAgent.Hist.Recorder
  alias SpellAgent.Hist.Store.Memory

  setup do
    for {mod, opts} <- [{Reg, []}, {Memory, []}, {DataSources, []}] do
      case Process.whereis(mod) do
        nil -> start_supervised!({mod, opts})
        _ -> :ok
      end
    end

    if Process.whereis(DataSources), do: DataSources.reset()
    :ok
  end

  # A process that registers `sid` with lineage `meta` and stays alive so the
  # registry monitor has a live owner (register monitors self()).
  defp spawn_session(sid, meta) do
    parent = self()

    pid =
      spawn(fn ->
        Reg.register(sid, meta)
        send(parent, :registered)
        receive do: (:stop -> :ok)
      end)

    receive do: (:registered -> :ok)
    pid
  end

  defp record_turn(sid, attrs, parent_id \\ nil) do
    Recorder.record_node(Memory, sid, attrs, parent_id)
  end

  describe "sessions/1 union" do
    test "unions live registry lineage with the session's Hist content" do
      owner =
        spawn_session("cp_a", %{
          owner: :human,
          intent: "refactor auth",
          region: "fork-a"
        })

      n1 = record_turn("cp_a", %{say: "reading registry", status: :ok, tokens: %{input: 10, output: 5}})
      _n2 = record_turn("cp_a", %{say: "editing file", status: :ok, tokens: %{input: 20, output: 3}}, n1.id)

      [row] = Enum.filter(Cockpit.sessions(Memory), &(&1["id"] == "cp_a"))

      assert row["intent"] == "refactor auth"
      assert row["region"] == "fork-a"
      assert row["owner"] == "human"
      assert row["turns"] == 2
      assert row["cost"] == 38
      assert is_list(row["spans"])

      send(owner, :stop)
    end

    test "a child session surfaces its parent lineage" do
      owner = spawn_session("cp_child", %{owner: {:session, "cp_parent"}, parent_id: "cp_parent"})

      row = Enum.find(Cockpit.sessions(Memory), &(&1["id"] == "cp_child"))
      assert row["owner"] == "session:cp_parent"
      assert row["parent-id"] == "cp_parent"

      send(owner, :stop)
    end
  end

  describe "bounds" do
    test "at most @max_sessions rows are returned" do
      owners =
        for i <- 1..(Cockpit.max_sessions() + 4) do
          spawn_session("cp_bound_#{i}", %{intent: "s#{i}"})
        end

      assert length(Cockpit.sessions(Memory)) <= Cockpit.max_sessions()

      Enum.each(owners, &send(&1, :stop))
    end

    test "only the last-N turns are carried per card" do
      owner = spawn_session("cp_span", %{intent: "many turns"})

      Enum.reduce(1..10, nil, fn i, parent ->
        record_turn("cp_span", %{say: "turn #{i}", status: :ok}, parent && parent.id).id
        |> then(&%{id: &1})
      end)

      row = Enum.find(Cockpit.sessions(Memory), &(&1["id"] == "cp_span"))
      assert row["turns"] == 10
      assert length(row["spans"]) <= 3

      send(owner, :stop)
    end
  end

  describe "never-brick" do
    test "a session with no recorded trace still yields a row (empty content)" do
      owner = spawn_session("cp_empty", %{intent: "just started"})

      row = Enum.find(Cockpit.sessions(Memory), &(&1["id"] == "cp_empty"))
      assert row["turns"] == 0
      assert row["cost"] == 0
      assert row["spans"] == []

      send(owner, :stop)
    end

    test "a nil/absent store degrades every row to unavailable content, never raises" do
      owner = spawn_session("cp_nostore", %{intent: "x"})

      row = Enum.find(Cockpit.sessions(nil), &(&1["id"] == "cp_nostore"))
      assert row["intent"] == "x"
      assert row["turns"] == 0
      assert row["last"] == "(snapshot unavailable)"

      send(owner, :stop)
    end

    test "registry down → [] (best-effort), never raises" do
      stop_supervised(Reg)
      if pid = Process.whereis(Reg), do: Process.exit(pid, :kill)
      Process.sleep(10)

      assert Cockpit.sessions(Memory) == []
    end
  end

  describe "install/0 (periphery registration)" do
    test "registers exactly one data source under data/sessions" do
      :ok = Cockpit.install()

      assert Cockpit.source_name() == "sessions"
      assert "sessions" in DataSources.names()

      owner = spawn_session("cp_src", %{intent: "via source"})
      resolved = DataSources.resolve_all(%{hist_store: Memory})
      assert is_list(resolved["sessions"])
      assert Enum.any?(resolved["sessions"], &(&1["id"] == "cp_src"))

      send(owner, :stop)
    end
  end
end
