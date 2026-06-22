defmodule SpellAgent.Tui.CellDemosTest do
  @moduledoc """
  W4 (PROJ-004): the reactive-cell demos as executable integration tests — the
  end-to-end proof of the `cell/define` vocabulary the prelude
  (`priv/prompts/freeform_tui.md`) teaches. Each `test` IS a demo: it exercises
  the documented pattern through the real `cell/` verb, the registry, the
  read-only tier, the slow-clock decision, and the DataBag merge, exactly as an
  agent authoring at runtime would.

  These double as the worked examples behind the prelude's "Reactive cells"
  section and stand as the acceptance proof of PROJ-004: a pane declares a
  read-only data dependency, the runtime satisfies it off the frame clock, the
  result lands in `data/*`, and a hole reads it as ordinary data — with zero
  per-frame effects.
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp
  alias SpellAgent.Tui.{DataBag, HoleResolver}
  alias SpellAgent.Tui.Cell.{Clock, Registry, Tools, Verb}
  alias SpellAgent.Tui.Store.Span
  alias SpellAgent.Tui.Ui

  setup do
    case Process.whereis(Registry) do
      nil -> start_supervised!(Registry)
      _pid -> :ok
    end

    Registry.reset()
    :ok
  end

  defp tools, do: Verb.tools()
  defp run(src, t), do: Lisp.run(src, tools: t, caller: :in_process_v1)

  # A frozen tmpl tree: the resolver host consumes step.return (the codec tree).
  defp frozen(src) do
    {:ok, step} = Lisp.run(src)
    step.return
  end

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

  # ============================================================
  # The documented patterns, executed end to end.
  # ============================================================

  # 1. DECLARE-AND-REFERENCE — the headline pattern from the prelude.
  test "demo 1: cell/define declares a cursor-keyed cell; a hole reads its result" do
    {:ok, step} =
      run(
        ~S|(cell/define {:name "callers" :query (quote (let [_ (get data/ui :cursor)] (harness/descendants {:id (harness/cursor-id)}))) :debounce 80})|,
        tools()
      )

    assert step.return["ok"] == true
    # The declared dependency is data/ui (the trigger), extracted from the
    # (get data/ui :cursor) leaf — the let binding makes the cursor a dependency
    # while harness/cursor-id maps the row to the span id the walk needs.
    assert step.return["deps"] == ["ui"]

    # The runtime resolves it off-frame (here we drive Clock.resolve directly, as
    # the slow clock would). Cursor at row 0 = "root" -> its descendants are c, g.
    env = %{"ui" => %{"cursor" => 0}}
    assert {:ok, q, value} = Clock.resolve("callers", env, {forest(), tree_ui()})
    Registry.put_resolved("callers", q, value)

    # And a pure hole reads it as ordinary data/callers.
    bag = DataBag.build(%{vms: %{}, ui: tree_ui()}, %{x: 0, y: 0, width: 1, height: 1})
    t = frozen(~S|(tmpl:: {:type "list" :items [~@data/callers]})|)
    rendered = HoleResolver.resolve_holes(t, bag)
    assert Enum.sort(rendered["items"]) == ["c", "g"]
  end

  # 2. ZERO PER-FRAME COST — the render path only READS the resolved value; no
  #    eval, no tool, happens when the bag is built.
  test "demo 2: a resolved cell appears in data/* as a pure read (no frame effect)" do
    q = quote_query(~S|(get data/ui :cursor)|)
    {:ok, _} = Registry.define("row", q)
    Registry.put_resolved("row", q, 7)

    # Building the bag is a pure merge — it surfaces data/row without resolving.
    bag = DataBag.build(%{vms: %{}, ui: %{}}, %{x: 0, y: 0, width: 1, height: 1})
    assert bag["row"] == 7
  end

  # 3. LIVE RE-RESOLUTION — when the dependency changes, the cell is dirty.
  test "demo 3: a cursor move makes a data/ui-keyed cell dirty" do
    q = quote_query(~S|(get data/ui :cursor)|)
    {:ok, _} = Registry.define("row", q)
    Registry.put_resolved("row", q, 0)

    prev = %{"ui" => %{"cursor" => 0}}
    curr = %{"ui" => %{"cursor" => 2}}
    assert Clock.dirty(prev, curr) == ["row"]
  end

  # 4. READ-ONLY BOUNDARY — a cell may read the forest, but a mutator is denied.
  test "demo 4: a cell reads the forest but cannot mutate" do
    {:ok, _} = Registry.define("ok", quote_query(~S|(harness/descendants {:id "root"})|))

    {:ok, _} =
      Registry.define(
        "evil",
        quote_query(~S|(keymap/bind {:chord "x" :intent "app/quit" :context "tree"})|)
      )

    tier = Tools.read_only(forest(), tree_ui())
    assert {:ok, _q, descendants} = Clock.resolve("ok", %{}, {forest(), tree_ui()})
    assert Enum.sort(descendants) == ["c", "g"]
    # The mutator cell resolves to :error — the keymap is never bound by a cell.
    assert :error = Clock.resolve("evil", %{}, {forest(), tree_ui()})
  end

  # 5. QUOTE REQUIRED — a non-quoted (bare value) query is rejected with a clear
  #    error, matching the prelude rule ":query MUST be (quote …)".
  test "demo 5: a non-deferred query is rejected" do
    {:ok, step} = run(~S|(cell/define {:name "bad" :query "literal"})|, tools())
    assert step.return["err"] =~ "query"
    assert Registry.get("bad") == nil
  end

  # 6. NO CYCLES — a cell may not depend on its own key.
  test "demo 6: a self-dependent cell is rejected" do
    {:ok, step} = run(~S|(cell/define {:name "loop" :query (quote (get data/loop :v))})|, tools())
    assert step.return["err"] =~ "self_dependency"
  end

  # 7. NO CELL-CYCLES — a loop across cells is rejected at define time.
  test "demo 7: a two-cell cycle is rejected" do
    {:ok, _} = Registry.define("a", quote_query(~S|(get data/b :v)|))
    {:ok, step} = run(~S|(cell/define {:name "b" :query (quote (get data/a :v))})|, tools())
    assert step.return["err"] =~ "cyclic_dependency"
  end

  # 8. INTROSPECTION — cell/list shows declared cells + deps.
  test "demo 8: cell/list reflects declared cells" do
    {:ok, _} = run(~S|(cell/define {:name "x" :query (quote (get data/ui :cursor))})|, tools())
    {:ok, step} = run(~S|(cell/list {})|, tools())
    assert [%{"name" => "x", "deps" => ["ui"], "resolved" => false}] = step.return
  end

  # 9. REMOVAL — cell/remove drops a cell so it no longer merges.
  test "demo 9: cell/remove undeclares a cell" do
    q = quote_query(~S|(get data/ui :cursor)|)
    {:ok, _} = Registry.define("x", q)
    Registry.put_resolved("x", q, 5)
    {:ok, _} = run(~S|(cell/remove {:name "x"})|, tools())

    bag = DataBag.build(%{vms: %{}, ui: %{}}, %{x: 0, y: 0, width: 1, height: 1})
    refute Map.has_key?(bag, "x")
  end

  # 10. ONE-KEY-EQUALS-ONE-LIVE-VALUE — a brand-new cell is referenceable by a
  #     hole with no render-path change, exactly like a bag key.
  test "demo 10: a new cell is a new data/* key, referenceable with zero new code" do
    q = quote_query(~S|(harness/descendants {:id "root"})|)
    {:ok, _} = Registry.define("kids", q)
    Registry.put_resolved("kids", q, ["c", "g"])

    bag = DataBag.build(%{vms: %{}, ui: %{}}, %{x: 0, y: 0, width: 1, height: 1})
    t = frozen(~S|(tmpl:: {:n ~(count data/kids)})|)
    assert HoleResolver.resolve_holes(t, bag)["n"] == 2
  end

  # A quoted query: `quote` returns codec data, the cell's persist shape.
  defp quote_query(src) do
    {:ok, step} = Lisp.run("(quote #{src})")
    step.return
  end
end
