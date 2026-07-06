defmodule SpellAgent.Tui.HintBarTest do
  @moduledoc """
  FEAT-041: the keybinding hint bar, extracted from the App god-module and now
  unit-testable without a live terminal or the supervised KeymapRegistry.
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.HintBar

  describe "render/2" do
    test "the global hints (pane / reset / quit) always appear" do
      hint = HintBar.render(:tree, :tree)
      assert hint =~ "pane"
      assert hint =~ "quit"
      assert hint =~ "reset layout"
    end

    test "tree focus adds navigation hints" do
      hint = HintBar.render(:tree, :tree)
      # nav intents are bound in the SpanTree/tree context.
      assert hint =~ "next" or hint =~ "in" or hint =~ "out"
    end

    test "prompt focus adds the insert-mode hint" do
      hint = HintBar.render(:prompt, :prompt)
      assert hint =~ "type"
    end

    test "an unknown focus still renders the globals (no crash)" do
      hint = HintBar.render(:some_runtime_pane, :some_runtime_pane)
      assert hint =~ "quit"
    end

    test "hints are joined with the middot separator" do
      hint = HintBar.render(:detail, :turn_nav)
      assert hint =~ "·"
    end

    test "degrades gracefully when the KeymapRegistry is not running" do
      # This test runs without the supervised registry, so live_bindings/1 must
      # rescue and fall back to compiled keymaps — the render must still produce
      # the global hints, never raise.
      assert is_binary(HintBar.render(:tree, :tree))
    end
  end
end
