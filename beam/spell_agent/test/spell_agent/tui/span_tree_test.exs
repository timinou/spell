defmodule SpellAgent.Tui.Panes.SpanTreeTest do
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.Panes.SpanTree
  alias SpellAgent.Tui.Store.Span

  # Build a forest map directly (project/2 is pure over the map — no GenServer).
  # run1
  #   turn 1
  #   tool1 (sub_agent)
  #     run2
  #       llm2
  defp forest do
    %{
      "run1" => %Span{
        id: "run1",
        parent_id: nil,
        kind: :run,
        status: :ok,
        label: "run root",
        t0: 1,
        t1: 9,
        turns: [%{number: 1, program: "(tool/sub {})", result_preview: "42", response: nil, status: :ok}],
        children: ["tool1"]
      },
      "tool1" => %Span{
        id: "tool1",
        parent_id: "run1",
        kind: :tool,
        status: :ok,
        label: "tool sub_agent",
        t0: 2,
        t1: 8,
        children: ["run2"]
      },
      "run2" => %Span{
        id: "run2",
        parent_id: "tool1",
        kind: :run,
        status: :ok,
        label: "run child",
        t0: 3,
        t1: 7,
        turns: [],
        children: ["llm2"]
      },
      "llm2" => %Span{id: "llm2", parent_id: "run2", kind: :llm, status: :ok, label: "llm haiku", t0: 4, t1: 6}
    }
  end

  test "project flattens the forest depth-first with turns inline under runs" do
    %{rows: rows, count: count} = SpanTree.project(forest(), %{})

    shape = Enum.map(rows, fn r -> {r.depth, r.id} end)

    assert shape == [
             {0, "run1"},
             {1, "run1#t1"},
             {1, "tool1"},
             {2, "run2"},
             {3, "llm2"}
           ]

    assert count == 5
  end

  test "selected_id resolves the cursor row's span id (for {:selected, :tree})" do
    vm = SpanTree.project(forest(), %{})
    # cursor 3 = run2 (the nested sub-agent's run) — drilling inside the insides.
    assert SpanTree.selected_id(vm, 3) == "run2"
    # clamps past the end.
    assert SpanTree.selected_id(vm, 999) == "llm2"
  end

  test "view marks the cursor row when focused and emits a list descriptor" do
    vm = SpanTree.project(forest(), %{})
    [{{:list, desc}, :fill}] = SpanTree.view(%{vm: vm, rect: :fill, assigns: %{cursor: 2}, focused?: true})

    assert desc.cursor == 2
    assert desc.focused? == true
    # the focused cursor row carries the › cursor marker (PLAN-346 W2 changed it
    # from ▸ so the disclosure glyph ▸/▾ can mean collapse state).
    assert Enum.at(desc.lines, 2).text =~ "›"
    # a non-cursor row does not.
    refute Enum.at(desc.lines, 0).text =~ "›"
  end

  test "events declares the suffixes that wake the pane (dirty filter)" do
    assert [:tool, :stop] in SpanTree.events()
    assert [:run, :start] in SpanTree.events()
  end

  # ---- W5: vim tree-navigation reactions ----

  alias SpellAgent.Tui.Ui

  defp tree_ui(row), do: Ui.new(focus: :tree, auto_depth: 1_000_000) |> Map.put(:cursors, %{tree: row})
  defp cur(ui), do: Ui.cursor_of(ui, :tree)

  describe "vim tree-nav (W5)" do
    test "nav/next and nav/prev move among visible rows, clamped" do
      f = forest()
      # rows: run1(0) turn1(1) tool1(2) run2(3) llm2(4)
      assert SpanTree.react(:"nav/next", tree_ui(0), f) |> cur() == 1
      assert SpanTree.react(:"nav/prev", tree_ui(0), f) |> cur() == 0, "clamps at top"
      assert SpanTree.react(:"nav/next", tree_ui(4), f) |> cur() == 4, "clamps at bottom"
    end

    test "nav/child descends into the cursor span's first child" do
      f = forest()
      # cursor on run1 (row 0); its first child row is 1.
      assert SpanTree.react(:"nav/child", tree_ui(0), f) |> cur() == 1
    end

    test "nav/parent ascends to the cursor span's parent row" do
      f = forest()
      # cursor on llm2 (row 4); parent run2 is at row 3.
      assert SpanTree.react(:"nav/parent", tree_ui(4), f) |> cur() == 3
    end

    test "nav/parent at a root stays put" do
      f = forest()
      assert SpanTree.react(:"nav/parent", tree_ui(0), f) |> cur() == 0
    end

    test "nav on an empty forest is a no-op (never crashes)" do
      assert SpanTree.react(:"nav/next", tree_ui(0), %{}) |> cur() == 0
      assert SpanTree.react(:"nav/child", tree_ui(0), %{}) |> cur() == 0
      assert SpanTree.react(:"nav/parent", tree_ui(0), %{}) |> cur() == 0
    end
  end

  test "selected_row returns the full row under the cursor (for the detail pane)" do
    f = forest()
    # row 1 = turn 1 under run1.
    row = SpanTree.selected_row(f, tree_ui(1))
    assert row.turn.number == 1
    # row 0 = the run span.
    assert SpanTree.selected_row(f, tree_ui(0)).span.id == "run1"
  end
end
