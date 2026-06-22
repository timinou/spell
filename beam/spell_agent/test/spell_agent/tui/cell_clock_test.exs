defmodule SpellAgent.Tui.Cell.ClockTest do
  @moduledoc """
  W3 contract (PROJ-004): the slow-clock decision + resolution core, the
  multi-cell cycle guard, and the App's end-to-end reactive loop.

  Pins:
    * `Clock.dirty/2` triggers exactly the cells whose deps changed (and ALL cells
      on the first tick), nothing on a no-op tick.
    * `Clock.resolve/3` resolves a cell through the read-only tier against live
      forest + bag, returning the value with the query for CAS.
    * The registry rejects a multi-cell dependency cycle at define time.
    * End-to-end: defining a cursor-keyed cell + moving the cursor drives an
      off-frame resolve that populates data/<cell> with ZERO per-frame effects.
  """
  use ExUnit.Case, async: false

  alias ExRatatui.Event.Key
  alias ExRatatui.Runtime
  alias PtcRunner.Lisp
  alias SpellAgent.Tui.{App, Store, Ui}
  alias SpellAgent.Tui.Cell.{Clock, Registry}
  alias SpellAgent.Tui.Store.Span

  setup do
    case Process.whereis(Registry) do
      nil -> start_supervised!(Registry)
      _pid -> :ok
    end

    Registry.reset()
    :ok
  end

  defp query(src) do
    {:ok, step} = Lisp.run("(quote #{src})")
    step.return
  end

  # ============================================================
  # Clock.dirty/2 — the trigger
  # ============================================================

  describe "dirty/2 selects cells whose deps changed" do
    test "first tick (prev nil) marks every registered cell dirty" do
      {:ok, _} = Registry.define("a", query(~S|(get data/ui :cursor-id)|))
      {:ok, _} = Registry.define("b", query(~S|(get data/x :v)|))
      assert Enum.sort(Clock.dirty(nil, %{"ui" => %{}})) == ["a", "b"]
    end

    test "only cells whose dep changed are dirty (once both are resolved)" do
      q_ui = query(~S|(get data/ui :cursor-id)|)
      q_x = query(~S|(get data/x :v)|)
      {:ok, _} = Registry.define("on_ui", q_ui)
      {:ok, _} = Registry.define("on_x", q_x)
      # Resolve both first, so neither is unresolved-dirty; only a real dep change
      # should then re-trigger.
      Registry.put_resolved("on_ui", q_ui, "a")
      Registry.put_resolved("on_x", q_x, 1)

      prev = %{"ui" => %{"cursor-id" => "a"}, "x" => 1}
      curr = %{"ui" => %{"cursor-id" => "b"}, "x" => 1}
      assert Clock.dirty(prev, curr) == ["on_ui"]
    end

    test "a no-op tick (identical bags) triggers nothing once cells are resolved" do
      q = query(~S|(get data/x :v)|)
      {:ok, _} = Registry.define("c", q)
      Registry.put_resolved("c", q, 1)
      bag = %{"x" => 1}
      assert Clock.dirty(bag, bag) == []
    end

    test "an UNRESOLVED cell is dirty even on a no-op tick (mid-session define)" do
      # A cell declared after the last bag change must still resolve once; folding
      # unresolved cells into the dirty set makes cell/define take effect promptly.
      {:ok, _} = Registry.define("fresh", query(~S|(get data/x :v)|))
      bag = %{"x" => 1}
      assert Clock.dirty(bag, bag) == ["fresh"]
    end
  end

  # ============================================================
  # Clock.resolve/3 — the read-only resolution
  # ============================================================

  describe "resolve/3 resolves a cell through the read-only tier" do
    defp forest do
      %{
        "root" => %Span{
          id: "root",
          parent_id: nil,
          kind: :run,
          status: :ok,
          label: "r",
          children: ["c"]
        },
        "c" => %Span{
          id: "c",
          parent_id: "root",
          kind: :tool,
          status: :ok,
          label: "t",
          children: ["g"]
        },
        "g" => %Span{id: "g", parent_id: "c", kind: :llm, status: :ok, label: "llm"}
      }
    end

    defp tree_ui, do: Ui.new(focus: :tree, auto_depth: 10) |> Map.put(:cursors, %{tree: 0})

    test "a cursor-keyed forest query resolves to live data with the query for CAS" do
      q = query(~S|(harness/descendants {:id (harness/cursor-id)})|)
      {:ok, _} = Registry.define("callers", q)

      assert {:ok, ^q, descendants} = Clock.resolve("callers", %{}, {forest(), tree_ui()})
      assert Enum.sort(descendants) == ["c", "g"]
    end

    test "an absent cell resolves to :error" do
      assert :error = Clock.resolve("ghost", %{}, {%{}, nil})
    end

    test "a cell whose query needs a forbidden mutator resolves to :error (read-only tier)" do
      {:ok, _} =
        Registry.define(
          "evil",
          query(~S|(keymap/bind {:chord "x" :intent "app/quit" :context "tree"})|)
        )

      assert :error = Clock.resolve("evil", %{}, {forest(), tree_ui()})
    end
  end

  # ============================================================
  # multi-cell cycle guard (registry, at define time)
  # ============================================================

  describe "the registry rejects multi-cell dependency cycles" do
    test "a two-cell cycle A->B->A is rejected" do
      {:ok, _} = Registry.define("a", query(~S|(get data/b :v)|))
      # b reads data/a, closing a -> b -> a.
      assert {:error, :cyclic_dependency} = Registry.define("b", query(~S|(get data/a :v)|))
    end

    test "a three-cell cycle A->B->C->A is rejected" do
      {:ok, _} = Registry.define("a", query(~S|(get data/b :v)|))
      {:ok, _} = Registry.define("b", query(~S|(get data/c :v)|))
      assert {:error, :cyclic_dependency} = Registry.define("c", query(~S|(get data/a :v)|))
    end

    test "a DAG (no cycle) is allowed: a->b, c->b" do
      {:ok, _} = Registry.define("b", query(~S|(get data/leaf :v)|))
      assert {:ok, _} = Registry.define("a", query(~S|(get data/b :v)|))
      assert {:ok, _} = Registry.define("c", query(~S|(get data/b :v)|))
    end

    test "a dep on a CORE bag key (not a cell) never counts as a cycle" do
      # data/ui is a core key, not a cell — a leaf, can't cycle.
      {:ok, _} = Registry.define("a", query(~S|(get data/ui :v)|))
      assert {:ok, _} = Registry.define("a2", query(~S|(get data/ui :v)|))
    end

    test "a cell named after a CORE key does not create a false cycle (W3r)" do
      # A cell literally named 'status' is inert at runtime (core data/status wins
      # in the bag merge), so a dep on data/status must be a LEAF, not an edge to
      # that cell. Without the core-key exclusion this would falsely reject 'a'.
      {:ok, _} = Registry.define("status", query(~S|(get data/a :v)|))
      assert {:ok, _} = Registry.define("a", query(~S|(get data/status :v)|))
    end

    test "a dense DAG defines without exponential blowup (W3r memoization)" do
      # d1 depends on d2..d20, d2 on d3..d20, etc. — a dense acyclic graph with
      # heavily shared subpaths. A per-path DFS would explode; the BFS with a
      # shared visited set defines all of them quickly (bounded-time smoke).
      for i <- 20..1//-1 do
        deps_src =
          (i + 1)..20//1
          |> Enum.map(fn j -> "(get data/d#{j} :v)" end)
          |> Enum.join(" ")

        src = if i == 20, do: "(get data/leaf :v)", else: "(str #{deps_src})"
        assert {:ok, _} = Registry.define("d#{i}", query(src))
      end

      assert map_size(Registry.all()) == 20
      # Closing the loop (d20 -> d1) must still be caught.
      assert {:error, :cyclic_dependency} = Registry.define("d20", query(~S|(get data/d1 :v)|))
    end
  end

  # ============================================================
  # End-to-end through the App: the live reactive loop
  # ============================================================

  describe "the App drives the reactive loop on the slow clock" do
    setup do
      {:ok, store} = Store.start_link(name: nil)
      %{store: store}
    end

    test "a forest-reading cell resolves off-frame into data/<name>", %{store: store} do
      # A gaze on the tree so harness/cursor-id resolves to the forest root.
      ui = Ui.new(focus: :tree, auto_depth: 10) |> Map.put(:cursors, %{tree: 0})

      {:ok, app} =
        App.start_link(
          name: nil,
          store: store,
          test_mode: {80, 24},
          ui: ui,
          on_submit: fn _ -> :ok end
        )

      # Seed a forest via telemetry (the real ingestion path; the App attached the
      # store on mount). harness/descendants then has a tree to walk.
      emit_forest()

      # Declare a cursor-keyed forest cell, tiny debounce so the test is quick.
      {:ok, _} =
        Registry.define("callers", query(~S|(harness/descendants {:id (harness/cursor-id)})|),
          debounce: 5
        )

      # Nudge the App through a reproject so the slow clock ticks + arms the timer.
      :ok = Runtime.inject_event(app, %Key{code: "j", kind: "press", modifiers: []})

      # Await the debounce + async resolve + the {:cell_resolved} reproject.
      assert eventually(fn -> Registry.get("callers").resolved end, fn r -> is_list(r) end)

      resolved = Registry.get("callers").resolved
      assert "g" in resolved or "c" in resolved
    end

    test "a cursor-keyed cell re-resolves when the cursor moves (live reactivity)", %{
      store: store
    } do
      ui = Ui.new(focus: :tree, auto_depth: 10) |> Map.put(:cursors, %{tree: 0})

      {:ok, app} =
        App.start_link(
          name: nil,
          store: store,
          test_mode: {80, 24},
          ui: ui,
          on_submit: fn _ -> :ok end
        )

      emit_forest()

      # A cell keyed on the cursor ROW via data/ui. The query reads data/ui :cursor
      # (its declared dependency — what makes it re-trigger) and echoes it. Moving
      # the cursor changes data/ui, the slow clock's dep-diff sees it, and the cell
      # re-resolves. This is the honest reactive pattern: the dependency is
      # expressed THROUGH data/* (a harness/cursor-id read would be invisible to
      # the dep-diff and never go live).
      {:ok, _} = Registry.define("row", query(~S|(get data/ui :cursor)|), debounce: 5)

      # Settle at the TOP (row 0): press k (clamps at 0, still a reproject tick).
      :ok = Runtime.inject_event(app, %Key{code: "k", kind: "press", modifiers: []})
      assert eventually(fn -> Registry.get("row").resolved end, fn r -> r == 0 end)

      # Move the cursor down twice (row 0 -> 2). The data/ui cursor change drives a
      # re-resolve to the new row — the core reactive contract: looking moved, the
      # cell re-resolved, off the frame clock.
      :ok = Runtime.inject_event(app, %Key{code: "j", kind: "press", modifiers: []})
      :ok = Runtime.inject_event(app, %Key{code: "j", kind: "press", modifiers: []})

      assert eventually(fn -> Registry.get("row").resolved end, fn r -> r == 2 end)
    end

    test "a cell whose query always fails settles to :failed, not a busy-loop", %{store: store} do
      ui = Ui.new(focus: :tree, auto_depth: 10) |> Map.put(:cursors, %{tree: 0})

      {:ok, app} =
        App.start_link(
          name: nil,
          store: store,
          test_mode: {80, 24},
          ui: ui,
          on_submit: fn _ -> :ok end
        )

      # A cell needing a mutator the read-only tier denies -> Cell.resolve :error
      # every time. It must settle to :failed (so it is NOT unconditionally dirty),
      # not retry forever on each reproject tick.
      {:ok, _} =
        Registry.define(
          "bad",
          query(~S|(keymap/bind {:chord "x" :intent "app/quit" :context "tree"})|),
          debounce: 5
        )

      :ok = Runtime.inject_event(app, %Key{code: "j", kind: "press", modifiers: []})
      assert eventually(fn -> Registry.get("bad").resolved end, fn r -> r == :failed end)

      # It stays :failed across further ticks (no dep change re-arms it).
      :ok = Runtime.inject_event(app, %Key{code: "k", kind: "press", modifiers: []})
      Process.sleep(40)
      assert Registry.get("bad").resolved == :failed
    end
  end

  # Emit a minimal span forest through the real telemetry ingestion path.
  defp emit_forest do
    :telemetry.execute([:ptc_runner, :sub_agent, :run, :start], %{}, %{
      span_id: "root",
      parent_span_id: nil,
      agent_name: "root"
    })

    :telemetry.execute([:ptc_runner, :sub_agent, :tool, :start], %{}, %{
      span_id: "c",
      parent_span_id: "root",
      tool_name: "find"
    })

    :telemetry.execute([:ptc_runner, :sub_agent, :llm, :start], %{}, %{
      span_id: "g",
      parent_span_id: "c"
    })

    :ok
  end

  # Poll `read` until `pred` is true or a timeout; returns the satisfying value or
  # fails the test. Async-resolve completion is event-driven, so a short poll is
  # the clean way to await it without a fixed sleep.
  defp eventually(read, pred, attempts \\ 50) do
    Enum.reduce_while(1..attempts, nil, fn _i, _acc ->
      val = read.()

      if pred.(val) do
        {:halt, true}
      else
        Process.sleep(10)
        {:cont, false}
      end
    end) || flunk("condition not met within timeout")
  end
end
