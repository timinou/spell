defmodule SpellAgent.Tui.LensFrameTargetTest do
  @moduledoc """
  PLAN-024 Wave 2 (FUP-031): spatial focus (`C-w h/j/k/l`) as a `lens/` PTC verb.

  `App.frame_target/2` (native `C-w`) and `Lens.frame_target/4` (the PTC verb)
  are now thin callers of the SAME `Lens.pane_regions/3` + `Spatial.extreme/2`
  pair — one source of truth for "which region is spatially extreme". This
  suite defends both the primitive AND the acceptance proof PLAN-024 names: an
  agent can reproduce today's native `C-w l` PURELY in PTC (a
  `keymap/define-reaction` authored from data, zero Elixir change) — the
  concrete demonstration that the spatial-jump primitive generalized, not just
  became callable.
  """
  use ExUnit.Case, async: false

  alias ExRatatui.Layout.Rect
  alias SpellAgent.Tui.{Chord, KeymapRegistry, Keys, Lens, PaneRegistry, Ui}
  alias SpellAgent.Tui.Keymap.Global

  setup do
    for {mod, start_opts} <- [{PaneRegistry, []}, {KeymapRegistry, []}] do
      case Process.whereis(mod) do
        nil -> start_supervised!({mod, start_opts})
        _ -> :ok
      end
    end

    PaneRegistry.reset()
    KeymapRegistry.reset()
    :ok
  end

  # The native 3-pane body: history | tree | detail, left to right (mirrors
  # DefaultLayout's real arrangement, hand-built here to stay unit-scoped).
  defp body_tree do
    %{
      "type" => "split",
      "slot" => "body",
      "dir" => "horizontal",
      "constraints" => [["percentage", 34], ["percentage", 30], ["percentage", 36]],
      "children" => [
        %{"type" => "pane", "slot" => "history", "tags" => %{"focused" => false}},
        %{"type" => "pane", "slot" => "tree", "tags" => %{"focused" => true}},
        %{"type" => "pane", "slot" => "detail", "tags" => %{"focused" => false}}
      ]
    }
  end

  defp area, do: %Rect{x: 0, y: 0, width: 100, height: 24}

  describe "Lens.pane_regions/3 — the shared geometry primitive" do
    test "lays out every focusable pane in tree order with its rect" do
      regions = Lens.pane_regions(body_tree(), area())
      slots = Enum.map(regions, &elem(&1, 0))
      assert slots == ["history", "tree", "detail"]
    end

    test "a non-focusable / non-pane leaf is excluded" do
      tree = %{
        "type" => "split",
        "dir" => "horizontal",
        "constraints" => [["percentage", 50], ["percentage", 50]],
        "children" => [
          %{"type" => "pane", "slot" => "tree", "tags" => %{}},
          %{"type" => "paragraph", "slot" => "status", "text" => "hi"}
        ]
      }

      regions = Lens.pane_regions(tree, area())
      assert Enum.map(regions, &elem(&1, 0)) == ["tree"]
    end

    test "an unrecognized pane name (never declared) is excluded — bounded" do
      tree = %{
        "type" => "split",
        "dir" => "horizontal",
        "constraints" => [["percentage", 100]],
        "children" => [%{"type" => "pane", "slot" => "never-declared-xyz", "tags" => %{}}]
      }

      assert Lens.pane_regions(tree, area()) == []
    end

    test "a malformed tree degrades to [] rather than raising" do
      assert Lens.pane_regions(%{"type" => "split", "dir" => "horizontal", "constraints" => "garbage"}, area()) ==
               []

      assert Lens.pane_regions(:not_a_tree, area()) == []
    end
  end

  describe "Lens.frame_target/4 — parity with App.frame_target/2's geometry" do
    test "right picks the rightmost pane, left the leftmost" do
      assert Lens.frame_target(body_tree(), :right, area()) == "detail"
      assert Lens.frame_target(body_tree(), :left, area()) == "history"
    end

    test "an empty/degraded tree yields nil, never raises" do
      assert Lens.frame_target(%{}, :right, area()) == nil
    end
  end

  describe "lens/frame-target — the PTC verb" do
    test "resolves a direction to a slot through the real PTC sandbox" do
      tools = Lens.tools(body_tree())

      assert {:ok, step} =
               PtcRunner.Lisp.run(~s|(lens/frame-target {:dir "right"})|, tools: tools, caller: :in_process_v1)

      assert step.return == "detail"
    end

    test "defaults to an 80x24 area when :width/:height are omitted" do
      tools = Lens.tools(body_tree())

      assert {:ok, step} =
               PtcRunner.Lisp.run(~s|(lens/frame-target {:dir "left"})|, tools: tools, caller: :in_process_v1)

      assert step.return == "history"
    end

    test "an unparseable :dir yields nil, not an error" do
      tools = Lens.tools(body_tree())

      assert {:ok, step} =
               PtcRunner.Lisp.run(~s|(lens/frame-target {:dir "diagonally"})|, tools: tools, caller: :in_process_v1)

      assert step.return == nil
    end
  end

  describe "acceptance: reproduce native C-w l PURELY in PTC (PLAN-024 Wave 2 proof)" do
    test "a keymap/define-reaction authored entirely as data reproduces the native C-w jump, through the REAL production dispatch path" do
      # Author a reaction: focus the spatially-rightmost pane. Zero Elixir
      # change: this is a value stored in KeymapRegistry, evaluated at dispatch.
      source = ~S"""
      (harness/focus {:dir (lens/frame-target {:dir "right"})})
      """

      :ok = KeymapRegistry.put_reaction(:tree, :"frame/jump-right", source)
      :ok = KeymapRegistry.bind(:tree, Chord.parse("g"), :"frame/jump-right")

      resolution = Keys.resolve(Chord.parse("g"), [:tree, Global])
      assert {:intent, :"frame/jump-right", :tree} = resolution

      # THE REAL PRODUCTION PATH: Keys.dispatch/5 with the live tree as its 5th
      # arg — exactly what App.handle_key_event's dispatch clause calls
      # (`Keys.dispatch(resolution, state.ui, forest, &Keys.context_name/1,
      # render_tree(state))`). Reaction.Ptc.run/4 merges `Lens.tools(tree)`
      # alongside `harness/`+`keymap/` internally — NOT hand-assembled here.
      # This is the fix for a review finding: an earlier version of this test
      # manually merged Harness.tools + Lens.tools and called PtcRunner.Lisp.run
      # directly, which proved the VERB worked but NOT that production dispatch
      # actually wires lens/ in — it didn't, until Wave 2's review caught it and
      # Keys.dispatch/Reaction.Ptc.run were extended with the `tree` arg.
      ui = Ui.new(focus: :tree, panes: [:history, :tree, :detail])
      result = Keys.dispatch(resolution, ui, %{}, &Keys.context_name/1, body_tree())

      assert result.focus == :detail
    end

    test "omitting the tree arg (pre-Wave-2 call shape) still dispatches harness/-only reactions unchanged" do
      :ok = KeymapRegistry.put_reaction(:tree, :"span/expand-legacy", ~S|(harness/expand {:id "x"})|)
      :ok = KeymapRegistry.bind(:tree, Chord.parse("y"), :"span/expand-legacy")

      resolution = Keys.resolve(Chord.parse("y"), [:tree, Global])
      ui = Ui.new(focus: :tree)

      # 3-arg call (no context_name fn, no tree) — the shape every pre-Wave-2
      # caller uses — must still work byte-identically.
      result = Keys.dispatch(resolution, ui, %{})
      assert result.overrides == %{"x" => :expanded}
    end

    test "a reaction calling lens/* with NO tree supplied degrades to the unchanged gaze, never crashes" do
      :ok = KeymapRegistry.put_reaction(:tree, :"frame/jump-right-notree", ~S|(harness/focus {:dir (lens/frame-target {:dir "right"})})|)
      :ok = KeymapRegistry.bind(:tree, Chord.parse("h"), :"frame/jump-right-notree")

      resolution = Keys.resolve(Chord.parse("h"), [:tree, Global])
      ui = Ui.new(focus: :tree)

      # No 5th arg -> tree defaults to nil -> lens/frame-target is UNDEFINED in
      # the tools map -> the sandboxed program errors -> Reaction.Ptc.run's own
      # fail-safe (rescue) returns the gaze UNCHANGED. Never a crash.
      result = Keys.dispatch(resolution, ui, %{})
      assert result == ui
    end
  end
end
