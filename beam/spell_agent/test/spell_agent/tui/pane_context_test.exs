defmodule SpellAgent.Tui.PaneContextTest do
  @moduledoc """
  PLAN-027 M4 (FUP-039): the focus → keymap-context registry that lets
  `App.base_focus_stack/1` resolve a pane's context generically instead of
  enumerating native panes in Elixir. Defends the registry contract + the
  never-brick floor equivalence (a down registry resolves the native panes
  identically via the compiled floor).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.PaneContext
  alias SpellAgent.Tui.Keymap.{Prompt, TurnNav}
  alias SpellAgent.Tui.Panes.SpanTree

  setup do
    case Process.whereis(PaneContext) do
      nil -> start_supervised!({PaneContext, []})
      _ -> :ok
    end

    PaneContext.reset()
    on_exit(fn -> if Process.whereis(PaneContext), do: PaneContext.reset() end)
    :ok
  end

  describe "register + lookup" do
    test "a registered focus resolves to its context module" do
      :ok = PaneContext.register(:tree, SpanTree)
      assert PaneContext.lookup(:tree) == SpanTree
    end

    test "register_all seeds several at once; re-register replaces" do
      :ok = PaneContext.register_all(%{tree: SpanTree, prompt: Prompt})
      assert PaneContext.lookup(:tree) == SpanTree
      assert PaneContext.lookup(:prompt) == Prompt

      :ok = PaneContext.register(:tree, TurnNav)
      assert PaneContext.lookup(:tree) == TurnNav
    end

    test "an unregistered focus resolves to nil (the fall-through signal)" do
      assert PaneContext.lookup(:never_registered) == nil
    end
  end

  describe "the native seed the App installs" do
    test "the four native focuses map to their keymap contexts" do
      :ok =
        PaneContext.register_all(%{tree: SpanTree, prompt: Prompt, detail: TurnNav, history: TurnNav})

      assert PaneContext.lookup(:tree) == SpanTree
      assert PaneContext.lookup(:prompt) == Prompt
      assert PaneContext.lookup(:detail) == TurnNav
      assert PaneContext.lookup(:history) == TurnNav
    end
  end
end
