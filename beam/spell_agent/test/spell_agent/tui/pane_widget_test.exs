defmodule SpellAgent.Tui.PaneWidgetTest do
  @moduledoc """
  FEAT-041: the pane descriptor -> widget materialization, extracted from the App
  god-module and now unit-testable without a live terminal.
  """
  use ExUnit.Case, async: true

  alias ExRatatui.Widgets.{List, Paragraph}
  alias SpellAgent.Tui.PaneWidget

  describe "run/1" do
    test "a :list descriptor becomes a List widget with a bordered block" do
      desc = %{title: "spans", lines: [%{text: "a", status: :ok}], focused?: true, cursor: 0}
      {widget, :rect} = PaneWidget.run({{:list, desc}, :rect})

      assert %List{} = widget
      assert widget.block.title == " spans "
      assert length(widget.items) == 1
      # a focused list with one item selects index 0.
      assert widget.selected == 0
    end

    test "an empty :list has no selection (ExRatatui would raise on an index)" do
      desc = %{title: "empty", lines: [], focused?: true, cursor: 3}
      {widget, _} = PaneWidget.run({{:list, desc}, :rect})
      assert widget.selected == nil
    end

    test "an unfocused :list has no selection" do
      desc = %{title: "t", lines: [%{text: "x", status: :ok}], focused?: false, cursor: 0}
      {widget, _} = PaneWidget.run({{:list, desc}, :rect})
      assert widget.selected == nil
    end

    test "a :detail descriptor becomes a scrollable Paragraph with a focus tag" do
      desc = %{title: "detail", body: "hello", scroll: 2, focused?: true}
      {widget, _} = PaneWidget.run({{:detail, desc}, :rect})

      assert %Paragraph{} = widget
      assert widget.text == "hello"
      assert widget.scroll == {2, 0}
      assert widget.block.title =~ "●"
    end

    test "a :history descriptor renders role-prefixed lines" do
      desc = %{
        empty?: false,
        scroll: 0,
        focused?: false,
        lines: [%{role: :user, text: "hi"}, %{role: :assistant, text: "yo"}]
      }

      {widget, _} = PaneWidget.run({{:history, desc}, :rect})
      assert widget.text =~ "you  hi"
      assert widget.text =~ "agent yo"
    end

    test "an empty :history shows the placeholder" do
      desc = %{empty?: true, scroll: 0, focused?: false, lines: []}
      {widget, _} = PaneWidget.run({{:history, desc}, :rect})
      assert widget.text =~ "no history yet"
    end

    test "an unrecognized placement passes through unchanged" do
      passthrough = {%Paragraph{text: "raw"}, :rect}
      assert PaneWidget.run(passthrough) == passthrough
    end
  end
end
