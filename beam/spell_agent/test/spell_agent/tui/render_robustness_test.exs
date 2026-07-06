defmodule SpellAgent.Tui.RenderRobustnessTest do
  @moduledoc """
  The single render contract (BUG-009 + BUG-010): `App.render/2` is TOTAL. A node
  whose resolution raises degrades to a GAP — it never raises on the direct (pure)
  call path, and never makes the runtime drop the whole frame on the live path.

  The load-bearing failure mode (verified, not hypothetical): a native pane's
  `view/1` RAISES when its view-model is malformed or missing — e.g. `vm: nil`
  (projection hasn't populated it, or a pane/vm key mismatch) makes
  `SpanTree.view/1` / `Detail.view/1` hit a no-function-clause. This happens
  INSIDE `resolve_pane` → `mod.view()`, BEFORE the final encode filter, so the
  pre-existing `encodable_placement?` guard does NOT catch it — only making
  resolution itself total does. Before the fix this raised straight out of the
  pure `render/2` (the "bad layout/body" tests saw) and dropped the whole live
  frame (the "doesn't update").

  We induce it by handing a pane a `nil` vm (a real projection gap), and
  separately by poisoning a slot widget so the encode path is exercised too.
  """

  use ExUnit.Case, async: false

  alias ExRatatui.Frame
  alias SpellAgent.Tui.{App, DefaultLayout, Lens, LayoutRegistry, Store, Ui}

  setup do
    {:ok, store} = Store.start_link(name: nil)
    ui = Ui.new(focus: :tree, panes: [:tree, :detail])
    default = DefaultLayout.tree(ui, ["tree", "detail"])

    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default})
      _ -> LayoutRegistry.seed_default(default)
    end

    on_exit(fn -> if Process.whereis(LayoutRegistry), do: LayoutRegistry.reset_all() end)

    %{store: store, ui: ui, default: default}
  end

  defp state(store, ui) do
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
      ui: ui,
      hist_session: nil,
      hist_store: nil,
      palette: SpellAgent.Tui.Palette.new()
    }
  end

  defp render(store, ui), do: App.render(state(store, ui), %Frame{width: 80, height: 24})

  # A state whose `detail` pane has a NIL vm — `Detail.view/1` raises on it. The
  # `tree` vm stays valid so we can prove the rest of the frame survives.
  defp state_with_nil_detail_vm(store, ui) do
    s = state(store, ui)
    %{s | vms: %{tree: %{rows: [], count: 0}, detail: nil}}
  end

  describe "BUG-010: direct render/2 never raises when a pane view raises" do
    test "a pane with a nil vm degrades to a gap; other panes survive", ctx do
      widgets = App.render(state_with_nil_detail_vm(ctx.store, ctx.ui), %Frame{width: 80, height: 24})

      # Reaching here is the contract (no raise). The detail pane dropped, but the
      # tree List + status + composer Paragraphs still render.
      kinds = Enum.map(widgets, fn {w, _r} -> w.__struct__ end)
      assert ExRatatui.Widgets.List in kinds
      assert ExRatatui.Widgets.Paragraph in kinds
    end

    test "an encode-poisoned slot widget also degrades to a gap", ctx do
      # text: 123 materializes to a struct that raises at Bridge encode — caught by
      # the trailing encode filter (belt to safe_resolve_node's braces).
      poisoned = Lens.put_at(ctx.default, "status", %{"type" => "paragraph", "text" => 123, "slot" => "status"})
      LayoutRegistry.replace(poisoned)

      widgets = render(ctx.store, ctx.ui)
      assert Enum.any?(widgets, fn {w, _r} -> w.__struct__ == ExRatatui.Widgets.List end)
    end

    test "a well-formed tree renders all four slots (control)", ctx do
      widgets = render(ctx.store, ctx.ui)
      # status + tree + detail + composer = 4 placements when nothing is poisoned.
      assert length(widgets) == 4
    end
  end

  describe "BUG-009: the live runtime never drops the whole frame" do
    test "an encode-poisoned slot still yields a non-empty rendered buffer", ctx do
      poisoned = Lens.put_at(ctx.default, "status", %{"type" => "paragraph", "text" => 123, "slot" => "status"})
      LayoutRegistry.replace(poisoned)

      {:ok, app} =
        App.start_link(name: nil, store: ctx.store, test_mode: {80, 24}, on_submit: fn _ -> :ok end)

      on_exit(fn -> if Process.alive?(app), do: Process.exit(app, :shutdown) end)

      # The frame must have been drawn (not dropped): the buffer is non-empty and
      # shows the surviving panes' chrome (the tree pane's "spans" title).
      assert {:ok, buffer} = ExRatatui.Runtime.buffer(app)
      assert buffer =~ "spans"
      refute buffer == ""
    end
  end
end