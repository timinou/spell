defmodule SpellAgent.Tui.Cell.RegistryTest do
  @moduledoc """
  W2 contract (PROJ-004): the reactive-cell registry, the `cell/define` verb, and
  the DataBag merge.

  Pins: define/get/remove lifecycle, dep extraction at define time, the cycle
  guard (a cell may not depend on its own output key), name validation + capacity
  bound, the resolved-value seam (put_resolved -> resolved_values, :unresolved
  omitted), the `cell/define` verb end-to-end through PtcRunner with a quoted
  query, and the DataBag merge (resolved cells appear as data/<name>; core keys
  win).
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp
  alias SpellAgent.Tui.Cell.{Registry, Verb}
  alias SpellAgent.Tui.DataBag

  setup do
    case Process.whereis(Registry) do
      nil -> start_supervised!(Registry)
      _pid -> :ok
    end

    Registry.reset()
    :ok
  end

  # A frozen query: `quote` returns codec data directly (the persist shape).
  defp query(src) do
    {:ok, step} = Lisp.run("(quote #{src})")
    step.return
  end

  # ============================================================
  # define / get / remove lifecycle + dep extraction
  # ============================================================

  describe "the registry stores cells with extracted deps" do
    test "define stores a cell and extracts its data/* deps" do
      assert {:ok, cell} =
               Registry.define(
                 "callers",
                 query(~S|(harness/descendants {:id (get data/ui :cursor-id)})|)
               )

      assert cell.deps == MapSet.new(["ui"])
      assert cell.resolved == :unresolved
      assert Registry.get("callers").deps == MapSet.new(["ui"])
    end

    test "a cell reading multiple keys records all deps" do
      assert {:ok, cell} =
               Registry.define("combo", query(~S|(str (get data/x :a) (get data/y :b))|))

      assert cell.deps == MapSet.new(["x", "y"])
    end

    test "remove drops the cell" do
      {:ok, _} = Registry.define("c", query(~S|(get data/x :v)|))
      Registry.remove("c")
      assert Registry.get("c") == nil
    end

    test "a custom debounce is stored; default applies otherwise" do
      {:ok, fast} = Registry.define("f", query(~S|(get data/x :v)|), debounce: 5)
      {:ok, dflt} = Registry.define("d", query(~S|(get data/x :v)|))
      assert fast.debounce == 5
      assert dflt.debounce == Registry.default_debounce_ms()
    end
  end

  # ============================================================
  # guards: name, cycle, capacity
  # ============================================================

  describe "define rejects invalid declarations" do
    test "an invalid name is rejected" do
      assert {:error, :invalid_name} = Registry.define("has/slash", query(~S|(get data/x :v)|))
      assert {:error, :invalid_name} = Registry.define("Caps", query(~S|(get data/x :v)|))
    end

    test "a self-dependency is rejected (cycle guard)" do
      # A cell named 'loop' that reads data/loop would re-resolve itself forever.
      assert {:error, :self_dependency} =
               Registry.define("loop", query(~S|(get data/loop :v)|))
    end

    test "a cell may depend on a DIFFERENT cell's key (not a self-cycle)" do
      assert {:ok, _} = Registry.define("b", query(~S|(get data/a :v)|))
    end

    test "the capacity bound rejects a new cell past the limit; replace still ok" do
      q = query(~S|(get data/x :v)|)
      for i <- 1..128, do: {:ok, _} = Registry.define("c#{i}", q)
      # 128 cells now declared; a NEW name is rejected.
      assert {:error, :too_many_cells} = Registry.define("overflow", q)
      # but REPLACING an existing name is always allowed (not a new slot).
      assert {:ok, _} = Registry.define("c1", query(~S|(get data/y :v)|))
    end
  end

  # ============================================================
  # the resolved-value seam (slow clock <-> frame clock)
  # ============================================================

  describe "resolved values are the bag-merge seam" do
    test "an unresolved cell is omitted from resolved_values" do
      {:ok, _} = Registry.define("c", query(~S|(get data/x :v)|))
      assert Registry.resolved_values() == %{}
    end

    test "put_resolved makes the value appear in resolved_values" do
      q = query(~S|(get data/x :v)|)
      {:ok, _} = Registry.define("c", q)
      Registry.put_resolved("c", q, ["a", "b"])
      assert Registry.resolved_values() == %{"c" => ["a", "b"]}
    end

    test "re-defining with the SAME query preserves the resolved value" do
      q = query(~S|(get data/x :v)|)
      {:ok, _} = Registry.define("c", q)
      Registry.put_resolved("c", q, 42)
      {:ok, _} = Registry.define("c", q)
      assert Registry.get("c").resolved == 42
    end

    test "re-defining with a DIFFERENT query resets to :unresolved" do
      q1 = query(~S|(get data/x :v)|)
      {:ok, _} = Registry.define("c", q1)
      Registry.put_resolved("c", q1, 42)
      {:ok, _} = Registry.define("c", query(~S|(get data/y :v)|))
      assert Registry.get("c").resolved == :unresolved
    end

    test "a stale resolve for the OLD query is discarded after redefine (CAS)" do
      # W2r finding #2: an async resolve dispatched for query A finishes AFTER the
      # cell was redefined with query B. put_resolved must reject A's value because
      # expected_query (A) no longer matches the current declaration (B).
      qa = query(~S|(get data/x :v)|)
      qb = query(~S|(get data/y :v)|)
      {:ok, _} = Registry.define("c", qa)
      {:ok, _} = Registry.define("c", qb)
      Registry.put_resolved("c", qa, "STALE")
      assert Registry.get("c").resolved == :unresolved
      # the CURRENT query's resolve still lands
      Registry.put_resolved("c", qb, "fresh")
      assert Registry.get("c").resolved == "fresh"
    end

    test "put_resolved on an absent cell is a no-op (not a crash)" do
      assert :ok = Registry.put_resolved("ghost", query(~S|(get data/x :v)|), 1)
      assert Registry.resolved_values() == %{}
    end

    test "a :failed cell is omitted from resolved_values (W3r busy-loop fix)" do
      {:ok, _} = Registry.define("c", query(~S|(get data/x :v)|))
      Registry.mark_failed("c")
      assert Registry.get("c").resolved == :failed
      assert Registry.resolved_values() == %{}
    end

    test "mark_failed on an absent cell is a no-op" do
      assert :ok = Registry.mark_failed("ghost")
    end
  end

  # ============================================================
  # dirty/1 — the W3 trigger set
  # ============================================================

  describe "dirty/1 selects cells whose deps changed" do
    test "returns cells whose dep set intersects the changed keys" do
      {:ok, _} = Registry.define("on_ui", query(~S|(get data/ui :cursor-id)|))
      {:ok, _} = Registry.define("on_x", query(~S|(get data/x :v)|))

      assert Registry.dirty(MapSet.new(["ui"])) == ["on_ui"]
      assert Enum.sort(Registry.dirty(MapSet.new(["ui", "x"]))) == ["on_ui", "on_x"]
      assert Registry.dirty(MapSet.new(["unrelated"])) == []
    end
  end

  # ============================================================
  # the cell/define verb (end to end through PtcRunner)
  # ============================================================

  describe "cell/define verb declares a cell from a quoted query" do
    test "a quoted query reaches the registry with deps extracted" do
      tools = Verb.tools()

      {:ok, step} =
        Lisp.run(
          ~S|(cell/define {:name "callers" :query (quote (harness/descendants {:id (get data/ui :cursor-id)})) :debounce 50})|,
          tools: tools,
          caller: :in_process_v1
        )

      assert step.return["ok"] == true
      assert step.return["name"] == "callers"
      assert step.return["deps"] == ["ui"]

      cell = Registry.get("callers")
      assert cell.debounce == 50
      assert cell.deps == MapSet.new(["ui"])
    end

    test "the verb rejects a non-map query with a clear error" do
      tools = Verb.tools()

      {:ok, step} =
        Lisp.run(~S|(cell/define {:name "bad" :query "not-coded"})|,
          tools: tools,
          caller: :in_process_v1
        )

      assert step.return["err"] =~ "query"
      assert Registry.get("bad") == nil
    end

    test "cell/list returns declared cells as data" do
      tools = Verb.tools()
      {:ok, _} = Registry.define("c", query(~S|(get data/x :v)|))

      {:ok, step} = Lisp.run(~S|(cell/list {})|, tools: tools, caller: :in_process_v1)
      assert [%{"name" => "c", "deps" => ["x"], "resolved" => false}] = step.return
    end
  end

  # ============================================================
  # DataBag merge — resolved cells become data/<name>
  # ============================================================

  describe "DataBag merges resolved cells into data/*" do
    test "a resolved cell appears in the bag under its name" do
      q = query(~S|(get data/ui :cursor-id)|)
      {:ok, _} = Registry.define("callers", q)
      Registry.put_resolved("callers", q, ["foo", "bar"])

      bag = DataBag.build(%{}, %{x: 0, y: 0, width: 80, height: 24})
      assert bag["callers"] == ["foo", "bar"]
    end

    test "an unresolved cell does NOT appear in the bag" do
      {:ok, _} = Registry.define("pending", query(~S|(get data/x :v)|))
      bag = DataBag.build(%{}, %{x: 0, y: 0, width: 80, height: 24})
      refute Map.has_key?(bag, "pending")
    end

    test "a cell may NOT shadow a core bag key (core wins)" do
      # Declare a cell literally named 'status' and resolve it to a sentinel; the
      # canonical data/status map must still win.
      q = query(~S|(get data/x :v)|)
      {:ok, _} = Registry.define("status", q)
      Registry.put_resolved("status", q, "HIJACKED")

      bag = DataBag.build(%{}, %{x: 0, y: 0, width: 80, height: 24})
      assert is_map(bag["status"]), "core data/status must win over a cell of the same name"
    end
  end
end
