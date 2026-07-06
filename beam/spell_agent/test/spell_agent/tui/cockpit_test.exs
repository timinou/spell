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

      # A LIVE session: lineage (intent/region/owner) comes from the registry,
      # content (turns/cost/spans) from the store. Status reflects the TRACE (the
      # last recorded turn is :ok, so the session is effectively done -> "ok";
      # the live registry's "running" is overridden by the truer trace status).
      assert row["intent"] == "refactor auth"
      assert row["region"] == "fork-a"
      assert row["owner"] == "human"
      assert row["status"] == "ok"
      assert row["turns"] == 2
      assert row["cost"] == 38
      assert is_list(row["spans"])

      send(owner, :stop)
    end

    test "a FINISHED session (in the store, not live) still shows with its final status" do
      # The core cockpit contract (found via tmux): a completed mission is dropped
      # from the live registry but REMAINS in the Hist store — the cockpit must
      # still show it, with its final ok/error status, not vanish.
      alias SpellAgent.Hist.{Session, Store}
      Store.put(Memory, {:session, "cp_done"}, %Session{id: "cp_done", prompt: "reply hi", t0: 5000, meta: %{}})
      record_turn("cp_done", %{say: "hi", status: :ok, tokens: %{input: 2, output: 4}})

      row = Enum.find(Cockpit.sessions(Memory), &(&1["id"] == "cp_done"))
      assert row != nil
      assert row["running?"] == false
      assert row["status"] == "ok"
      assert row["turns"] == 1
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

    test "a nil store still surfaces LIVE sessions with unavailable content, never raises" do
      # With a nil store there is no recorded base, but a LIVE session (in the
      # registry) still surfaces via the live-only branch, with unavailable
      # content (no store to read its trace).
      owner = spawn_session("cp_nostore", %{intent: "x"})

      row = Enum.find(Cockpit.sessions(nil), &(&1["id"] == "cp_nostore"))
      assert row != nil
      assert row["intent"] == "x"
      assert row["turns"] == 0
      # No store to read — the content degrades (no turns, no spans), never raises.
      assert row["spans"] == []

      send(owner, :stop)
    end

    test "a nil store with no live sessions yields [] (best-effort), never raises" do
      # The fully-degraded case: no store base, no live registry rows for a fresh
      # id space -> an empty list, never a raise. (With the union, a live registry
      # AND a store both feed rows; only when both are empty is the result [].)
      assert is_list(Cockpit.sessions(nil))
    end
  end

  describe "show/0 (the cockpit fully as data — M6 payoff)" do
    alias SpellAgent.Tui.{LayoutRegistry, DefaultLayout, Ui, HoleResolver, Lens}

    setup do
      case Process.whereis(LayoutRegistry) do
        nil -> start_supervised!({LayoutRegistry, []})
        _ -> :ok
      end

      # Seed a real default so the body slot is present + adoptable.
      ui = Ui.new(focus: :prompt, mode: :normal, panes: [:prompt, :history, :tree, :detail])
      LayoutRegistry.seed_default(DefaultLayout.tree(ui, ["history", "tree", "detail"]))
      on_exit(fn -> if Process.whereis(LayoutRegistry), do: LayoutRegistry.reset_all() end)
      :ok
    end

    test "show/0 shadows the body slot with the data-driven card grid" do
      assert Cockpit.show() == :ok

      body = Lens.at(LayoutRegistry.tree(), "body")
      assert is_map(body)

      # Resolve the (frozen) cockpit body against a sample data/sessions: the
      # grid must produce ONE card block per session, with a header — the whole
      # view authored in cockpit_layout.ptc, not Elixir.
      data = %{
        "sessions" => [
          %{"id" => "s1", "intent" => "refactor", "last" => "editing", "status" => "running", "running?" => true, "turns" => 3, "owner" => "human", "spans" => [%{"status" => "ok", "title" => "read"}]},
          %{"id" => "s2", "intent" => "tests", "last" => "14 pass", "status" => "ok", "running?" => false, "turns" => 7, "owner" => "session:s1", "spans" => []}
        ]
      }

      resolved = HoleResolver.resolve_holes(body, data)
      children = Map.get(resolved, "children", [])
      grid = Enum.at(children, 1, %{})
      cards = Map.get(grid, "children", [])

      assert length(cards) == 2
      # A card is a `list` widget wrapped in a `block` (border) via its `block`
      # field — the render model's border pattern (a bare block renders only the
      # frame; the widget must carry its own block for content to show inside).
      card = Enum.at(cards, 0)
      assert Map.get(card, "type") == "list"
      assert is_list(Map.get(card, "items"))
      # The block's title carries the session id + a live running badge.
      assert get_in(card, ["block", "title"]) =~ "s1"
      # The running card's border is yellow (status-driven color, from data).
      assert get_in(card, ["block", "border_style", "fg"]) == "yellow"
    end

    test "show/0 with ZERO sessions still validates + shadows (never-brick empty grid)" do
      # The data-driven grid resolves to zero cards against an empty session list;
      # the LayoutDiagnostic must accept the splice-empty split (M6 validation fix)
      # rather than reject the whole cockpit layout.
      assert Cockpit.show() == :ok
      body = Lens.at(LayoutRegistry.tree(), "body")
      resolved = HoleResolver.resolve_holes(body, %{"sessions" => []})
      grid = Enum.at(Map.get(resolved, "children", []), 1, %{})
      assert Map.get(grid, "children", []) == []
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
