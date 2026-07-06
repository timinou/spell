defmodule SpellAgent.Tui.FreeformIntegrationTest do
  @moduledoc """
  The freeform render mirror, end to end (PLAN-009): an agent program reshapes the
  live TUI through its real tool surface, and the App's render reflects it.

  This is the "test-drive" contract: the agent calls `layout/set` with a
  `view/`-built node (through the same PtcRunner sandbox + Tools surface a real
  run uses), and `App.render` then paints the shadowed slot.
  """
  use ExUnit.Case, async: false

  alias ExRatatui.Frame
  alias SpellAgent.Tui.{App, DefaultLayout, LayoutRegistry, Store, Ui}

  setup do
    {:ok, store} = Store.start_link(name: nil)

    # Seed the registry default so layout/set has slots to shadow.
    default =
      DefaultLayout.tree(Ui.new(panes: [:tree, :detail], focus: :tree), ["tree", "detail"])

    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default})
      _ -> LayoutRegistry.seed_default(default)
    end

    %{store: store}
  end

  defp app_state(store, overrides) do
    Map.merge(
      %{
        store: store,
        panes: [
          %{name: :tree, module: SpellAgent.Tui.Panes.SpanTree, assigns: %{}},
          %{name: :detail, module: SpellAgent.Tui.Panes.Detail, assigns: %{}}
        ],
        vms: %{tree: %{rows: [], count: 0}, detail: %{title: "detail", body: "(empty)"}},
        composer: "",
        on_submit: fn _ -> :ok end,
        running?: false,
        result: nil,
        last_prompt: nil,
        ui: Ui.new(focus: :tree, panes: [:tree, :detail]),
        palette: SpellAgent.Tui.Palette.new()
      },
      overrides
    )
  end

  defp status_text(widgets), do: elem(Enum.at(widgets, 0), 0).text

  test "an agent program shadows the status slot; App.render paints it", %{store: store} do
    # The agent's full tool surface (view/ + layout/ + lens/ + theme/ + meta).
    tools = SpellAgent.Tools.build_tools_map()

    # A program the agent could literally write: build a paragraph with view/ and
    # install it at the status slot via layout/set.
    src = ~s|(layout/set {:slot "status" :source (view/paragraph {:text "AGENT-OWNED STATUS"})})|

    assert {:ok, _step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)

    # The registry now holds the shadow.
    assert {:ok, shown} = LayoutRegistry.show("status")
    assert shown["text"] == "AGENT-OWNED STATUS"

    # And the App's render reflects it (the live tree's pane set matches the App's
    # 2 panes, so render uses the shadowed registry tree).
    widgets = App.render(app_state(store, %{}), %Frame{width: 80, height: 24})
    assert status_text(widgets) =~ "AGENT-OWNED STATUS"
  end

  test "a bad shadow is rejected; the native status still renders", %{store: store} do
    tools = SpellAgent.Tools.build_tools_map()
    src = ~s|(layout/set {:slot "status" :source {:type "no_such_widget"}})|

    {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
    # layout/set returns a structured error map for a rejected shadow.
    assert is_map(step.return) and Map.has_key?(step.return, "err")
    assert step.return["reason"] == "bad_layout"
    assert step.return["diagnostic"]["path"] == "source.type"
    assert step.return["diagnostic"]["reason"] == "unknown_widget"

    # Native status still renders (the failure ladder kept last-good = default).
    widgets = App.render(app_state(store, %{running?: true}), %Frame{width: 80, height: 24})
    assert status_text(widgets) =~ "running"
  end

  test "an agent program with invalid paragraph.wrap is rejected before it can freeze render", %{
    store: store
  } do
    tools = SpellAgent.Tools.build_tools_map()

    src =
      ~s|(layout/set {:slot "status" :source (view/paragraph {:text "BAD" :wrap "word"})})|

    {:ok, step} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)

    assert step.return["reason"] == "bad_layout"
    assert step.return["diagnostic"]["path"] == "source.wrap"
    assert step.return["diagnostic"]["reason"] == "invalid_field"
    assert step.return["err"] =~ "expected boolean"

    widgets = App.render(app_state(store, %{running?: true}), %Frame{width: 80, height: 24})
    assert status_text(widgets) =~ "running"
  end

  test "theme/set recolors via the live palette", %{store: _store} do
    case Process.whereis(SpellAgent.Tui.ThemeRegistry) do
      nil -> start_supervised!(SpellAgent.Tui.ThemeRegistry)
      _ -> SpellAgent.Tui.ThemeRegistry.reset()
    end

    tools = SpellAgent.Tools.build_tools_map()

    {:ok, _} =
      PtcRunner.Lisp.run(~s|(theme/set {:slot "danger" :fg "magenta"})|,
        tools: tools,
        caller: :in_process_v1
      )

    assert SpellAgent.Tui.ThemeRegistry.as_map()["danger"] == "magenta"
  end
end
