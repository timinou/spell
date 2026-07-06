defmodule SpellAgent.Tui.UiTest do
  @moduledoc "Unit tests for the Ui gaze struct + its pure transforms (PLAN-346 W1)."
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.Ui

  describe "focus ring" do
    test "next/prev cycle through the pane ring and wrap" do
      ui = Ui.new(panes: [:tree, :detail, :prompt], focus: :tree)
      assert Ui.focus(ui, :next).focus == :detail
      assert ui |> Ui.focus(:next) |> Ui.focus(:next) |> Map.get(:focus) == :prompt
      # wrap forward
      assert ui |> Ui.focus(:next) |> Ui.focus(:next) |> Ui.focus(:next) |> Map.get(:focus) == :tree
      # wrap backward
      assert Ui.focus(ui, :prev).focus == :prompt
    end

    test "jump to a named pane (only if in the ring)" do
      ui = Ui.new(focus: :tree)
      assert Ui.focus(ui, :detail).focus == :detail
      assert Ui.focus(ui, :nonexistent).focus == :tree
    end

    test "single-pane ring: next/prev stay put" do
      ui = Ui.new(panes: [:tree], focus: :tree)
      assert Ui.focus(ui, :next).focus == :tree
      assert Ui.focus(ui, :prev).focus == :tree
    end

    test "empty ring: focus is total (identity), never crashes" do
      ui = Ui.new(panes: [], focus: :tree)
      assert Ui.focus(ui, :next) == ui
      assert Ui.focus(ui, :prev) == ui
    end
  end

  describe "cursor (within focused pane)" do
    test "moves the focused pane's cursor and clamps at 0" do
      ui = Ui.new(focus: :tree)
      assert Ui.cursor(ui, +1) |> Ui.cursor_of(:tree) == 1
      assert Ui.cursor(ui, -5) |> Ui.cursor_of(:tree) == 0
    end

    test "cursor is per-pane (moving tree doesn't touch answer)" do
      ui = Ui.new(focus: :tree) |> Ui.cursor(+3)
      assert Ui.cursor_of(ui, :tree) == 3
      assert Ui.cursor_of(ui, :detail) == 0
    end

    test ":first and :last sentinels" do
      ui = Ui.new(focus: :tree) |> Ui.cursor(+5)
      assert Ui.cursor(ui, :first) |> Ui.cursor_of(:tree) == 0
      assert Ui.cursor(ui, :last) |> Ui.cursor_of(:tree) == 1_000_000
    end
  end

  describe "collapse-by-depth visibility (D4)" do
    test "default auto_depth=1: depth-0 expanded, depth-1 collapsed" do
      ui = Ui.new()
      assert Ui.expanded?(ui, 0, "run")
      refute Ui.expanded?(ui, 1, "tool")
    end

    test "explicit :expanded override beats the depth rule" do
      ui = Ui.new() |> Ui.expand("tool")
      assert Ui.expanded?(ui, 1, "tool")
    end

    test "explicit :collapsed override beats the depth rule" do
      ui = Ui.new() |> Ui.collapse("run")
      refute Ui.expanded?(ui, 0, "run")
    end

    test "overrides are a property of the gaze, keyed by span id" do
      ui = Ui.new() |> Ui.expand("a") |> Ui.collapse("b")
      assert ui.overrides == %{"a" => :expanded, "b" => :collapsed}
    end

    test "toggle flips effective state at a depth" do
      ui = Ui.new()
      # depth-1 default collapsed -> toggle expands
      ui2 = Ui.toggle(ui, 1, "tool")
      assert Ui.expanded?(ui2, 1, "tool")
      # toggle again collapses
      ui3 = Ui.toggle(ui2, 1, "tool")
      refute Ui.expanded?(ui3, 1, "tool")
    end

    test "auto_depth=2 expands one level deeper" do
      ui = Ui.new(auto_depth: 2)
      assert Ui.expanded?(ui, 1, "tool")
      refute Ui.expanded?(ui, 2, "nested")
    end
  end

  describe "turn navigation" do
    test "next increments, prev decrements and clamps at 0" do
      ui = Ui.new()
      assert Ui.turn(ui, :next).turn == 1
      assert Ui.turn(ui, :prev).turn == 0
      assert ui |> Ui.turn(:next) |> Ui.turn(:next) |> Ui.turn(:prev) |> Map.get(:turn) == 1
    end
  end

  describe "scroll" do
    test "per-pane, clamps at 0" do
      ui = Ui.new()
      assert Ui.scroll(ui, :detail, +5) |> Ui.scroll_of(:detail) == 5
      assert Ui.scroll(ui, :detail, -100) |> Ui.scroll_of(:detail) == 0
      assert Ui.scroll(ui, :detail, +5) |> Ui.scroll_of(:tree) == 0
    end
  end

  test "a fresh gaze has the documented defaults" do
    ui = Ui.new()
    assert ui.focus == :tree
    assert ui.panes == [:tree, :detail, :prompt]
    assert ui.mode == :normal
    assert ui.auto_depth == 1
    assert ui.overrides == %{}
    assert ui.turn == 0
    assert ui.leader == nil
  end

  test "mode toggles between :normal and :insert" do
    ui = Ui.new()
    assert Ui.mode(ui, :insert).mode == :insert
    assert ui |> Ui.mode(:insert) |> Ui.mode(:normal) |> Map.get(:mode) == :normal
  end

  describe "safe_flags (bounded UI toggle state)" do
    test "caps at 32 entries and stringifies keys" do
      big = for i <- 1..100, into: %{}, do: {"k#{i}", true}
      flags = Ui.safe_flags(big)
      assert map_size(flags) == 32
      assert Enum.all?(Map.keys(flags), &is_binary/1)
    end

    test "an over-cap value is dropped to nil (review S3 P1: no unbounded flag growth)" do
      # flags round-trips into reactions, so a reaction must not be able to accrete
      # an ever-growing value under a key. A value past the byte cap becomes nil;
      # the key survives as a presence marker.
      huge = String.duplicate("x", 10_000)
      flags = Ui.safe_flags(%{"big" => huge, "small" => "ok"})
      assert flags["big"] == nil
      assert flags["small"] == "ok"
    end

    test "a small value survives" do
      flags = Ui.safe_flags(%{"cells-drawer" => true})
      assert flags["cells-drawer"] == true
    end
  end
end
