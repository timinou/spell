defmodule SpellAgent.Tui.LensTest do
  @moduledoc """
  The gaze/render unification (PLAN-009, D1): the layout tree IS the gaze.

  Defends the load-bearing contracts of `Lens`:
    * to_ui materializes the gaze from tree tags (focus/cursor/scroll/mode/ring),
    * from_ui folds a reaction's %Ui{} back losslessly (the round-trip),
    * lens/focus re-tags the tree (focus ring as a pure tree -> tree op),
    * the round-trip is exact, so the existing %Ui{}-speaking reaction algebra and
      the new tree are one source of truth (nothing to desync).
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.{Lens, Ui}

  defp tree do
    ui = Ui.new(panes: [:tree, :detail, :prompt], focus: :tree, mode: :normal, auto_depth: 1)

    %{
      "type" => "split",
      "dir" => "vertical",
      "tags" => Lens.root_tags(ui),
      "children" => [
        %{
          "type" => "pane",
          "slot" => "tree",
          "tags" => %{"focused" => true, "cursor" => 2, "scroll" => 0}
        },
        %{
          "type" => "pane",
          "slot" => "detail",
          "tags" => %{"focused" => false, "cursor" => 0, "scroll" => 5}
        },
        %{
          "type" => "pane",
          "slot" => "prompt",
          "tags" => %{"focused" => false, "cursor" => 0, "scroll" => 0}
        }
      ]
    }
  end

  describe "to_ui — gaze from tags" do
    test "reads focus, cursors, scroll, ring from the tree" do
      ui = Lens.to_ui(tree())
      assert ui.focus == :tree
      assert ui.panes == [:tree, :detail, :prompt]
      assert Ui.cursor_of(ui, :tree) == 2
      assert Ui.scroll_of(ui, :detail) == 5
    end

    test "a tree with no focused pane falls back to the first ring pane" do
      t = tree()
      # clear all focused flags
      children = Enum.map(t["children"], fn p -> put_in(p, ["tags", "focused"], false) end)
      ui = Lens.to_ui(%{t | "children" => children})
      assert ui.focus == :tree
    end
  end

  describe "from_ui — fold a reaction's gaze back (the round-trip)" do
    test "to_ui . from_ui is identity on the gaze fields" do
      t = tree()
      ui = Lens.to_ui(t)
      ui2 = ui |> Ui.focus(:detail) |> Ui.cursor(3) |> Ui.scroll(:detail, +2)

      back = t |> Lens.from_ui(ui2) |> Lens.to_ui()

      assert back.focus == :detail
      assert Ui.cursor_of(back, :detail) == 3
      assert Ui.scroll_of(back, :detail) == 7
      assert back.panes == ui2.panes
    end

    test "overrides (collapse state) round-trip through the root tags" do
      t = tree()
      ui = Lens.to_ui(t) |> Ui.expand("span-x") |> Ui.collapse("span-y")
      back = t |> Lens.from_ui(ui) |> Lens.to_ui()
      assert back.overrides["span-x"] == :expanded
      assert back.overrides["span-y"] == :collapsed
    end
  end

  describe "lens/focus — the ring as a tree re-tag" do
    test "moving focus :next re-tags exactly one pane" do
      t = Lens.focus(tree(), :next)
      assert Lens.to_ui(t).focus == :detail
      # exactly one focused pane
      focused =
        Enum.filter(["tree", "detail", "prompt"], fn s ->
          node = Lens.at(t, s)
          Lens.tags(node)["focused"] == true
        end)

      assert focused == ["detail"]
    end

    test "focus wraps around the ring" do
      t = tree() |> Lens.focus(:prev)
      assert Lens.to_ui(t).focus == :prompt
    end

    test "focus to a named slot jumps directly" do
      t = Lens.focus(tree(), "prompt")
      assert Lens.to_ui(t).focus == :prompt
    end

    test "focusables lists the panes in tree order" do
      assert Lens.focusables(tree()) == ["tree", "detail", "prompt"]
    end
  end

  describe "focusables — the `focusable` tag as a real predicate (PLAN-024 Wave 1)" do
    test "a pane node with an explicit focusable=false opts OUT of the ring" do
      t = tree()

      children =
        Enum.map(t["children"], fn p ->
          if Lens.slot(p) == "detail", do: put_in(p, ["tags", "focusable"], false), else: p
        end)

      t = %{t | "children" => children}
      assert Lens.focusables(t) == ["tree", "prompt"]
    end

    test "a non-pane widget node opts IN to the ring via focusable=true" do
      t = tree()

      shadow = %{
        "type" => "paragraph",
        "slot" => "cost-histo",
        "tags" => %{"focusable" => true, "focused" => false, "cursor" => 0, "scroll" => 0},
        "text" => "hi"
      }

      t = Map.update!(t, "children", &(&1 ++ [shadow]))
      assert Lens.focusables(t) == ["tree", "detail", "prompt", "cost-histo"]
    end

    test "a non-pane widget node WITHOUT focusable stays out of the ring (no silent join)" do
      t = tree()

      plain = %{"type" => "paragraph", "slot" => "status", "text" => "hi"}
      t = Map.update!(t, "children", &(&1 ++ [plain]))
      assert Lens.focusables(t) == ["tree", "detail", "prompt"]
    end
  end

  describe "lens/ tools through the PTC sandbox" do
    test "lens/focus re-tags the closed-over tree" do
      tools = Lens.tools(tree())

      assert {:ok, step} =
               PtcRunner.Lisp.run(~s|(lens/focus {:dir "next"})|,
                 tools: tools,
                 caller: :in_process_v1
               )

      assert Lens.to_ui(step.return).focus == :detail
    end
  end
end
