defmodule SpellAgent.Tui.Panes.DetailTest do
  @moduledoc "The detail/inspector pane (PLAN-346 W5) \u2014 'see inside the turn'."
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.Panes.Detail
  alias SpellAgent.Tui.Store.Span
  alias SpellAgent.Tui.Ui

  defp forest do
    %{
      "r" => %Span{
        id: "r", parent_id: nil, kind: :run, status: :ok, label: "root",
        tokens: %{input: 100, output: 20}, t0: 1, t1: 5, children: ["t"],
        turns: [%{number: 1, program: "(tool/find {})", result_preview: "42", response: "thinking...", status: :ok}]
      },
      "t" => %Span{
        id: "t", parent_id: "r", kind: :tool, status: :error, label: "find",
        meta: %{tool_name: "find", result: "boom"}, t0: 2, t1: 4
      }
    }
  end

  defp ui_at(row), do: Ui.new(focus: :tree, auto_depth: 10) |> Map.put(:cursors, %{tree: row})

  test "selecting a TURN row shows its full program + result + reasoning" do
    vm = Detail.project(forest(), %{ui: ui_at(1)})
    assert vm.title =~ "turn 1"
    assert vm.body =~ "program"
    assert vm.body =~ "(tool/find {})"
    assert vm.body =~ "result"
    assert vm.body =~ "42"
    assert vm.body =~ "reasoning"
    assert vm.body =~ "thinking..."
  end

  test "selecting a run SPAN row shows its metadata (status, tokens, children)" do
    vm = Detail.project(forest(), %{ui: ui_at(0)})
    assert vm.title =~ "run"
    assert vm.body =~ "id: r"
    assert vm.body =~ "tokens: 100\u219220"
    assert vm.body =~ "children: 1"
  end

  test "selecting a tool SPAN row surfaces its result from metadata" do
    # row 2 = the tool "t" (run row 0, turn row 1, tool row 2)
    vm = Detail.project(forest(), %{ui: ui_at(2)})
    assert vm.title =~ "tool"
    assert vm.title =~ "\u2717"
    assert vm.body =~ "boom"
  end

  test "an empty forest yields a friendly placeholder, never crashes" do
    vm = Detail.project(%{}, %{ui: ui_at(0)})
    assert vm.title == "detail"
    assert vm.body =~ "no selection"
  end

  test "detail_of folds a row purely (no forest needed for a turn)" do
    row = %{turn: %{number: 3, program: "(+ 1 2)", result_preview: "3", response: nil, status: :ok}}
    vm = Detail.detail_of(%{}, row)
    assert vm.title == "turn 3 \u2713"
    assert vm.body =~ "(+ 1 2)"
    # a nil reasoning section is omitted.
    refute vm.body =~ "reasoning"
  end
end
