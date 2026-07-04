defmodule SpellAgent.Tui.PaneRegistryIntegrationTest do
  @moduledoc """
  PLAN-024 Wave 1 (FUP-005) end-to-end: an agent-declared pane becomes
  FOCUSABLE and NAVIGABLE through the real tool + resolver pipeline — the
  concrete generalization of "every chord is code" this wave targets.

  Proves the full loop with NO Elixir change per new pane:
    1. `harness/declare-pane` opens the bounded name into the vocabulary.
    2. `layout/set` shadows a body slot with a `:focusable true` widget under
       that name (already-existing PTC surface — no new policy).
    3. `Ui.safe_pane/1` (and therefore `App.focus_stack/1`) now recognizes the
       name — it can become the live gaze's `focus`.
    4. `keymap/bind` + `keymap/define-reaction`, with the declared name as
       `:context`, drive real navigation through `Keys.resolve/dispatch` when
       that pane is focused — a purely PTC-authored `C-w`-style affordance for
       a pane that has no compiled module at all.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{Chord, DefaultLayout, KeymapRegistry, Keys, Lens, LayoutRegistry, PaneRegistry, Ui}
  alias SpellAgent.Tui.Keymap.Global

  setup do
    for {mod, start_opts} <- [
          {PaneRegistry, []},
          {KeymapRegistry, []}
        ] do
      case Process.whereis(mod) do
        nil -> start_supervised!({mod, start_opts})
        _ -> :ok
      end
    end

    PaneRegistry.reset()
    KeymapRegistry.reset()

    default = DefaultLayout.tree(Ui.new(panes: [:tree, :detail], focus: :tree), ["tree", "detail"])

    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default})
      _ -> LayoutRegistry.seed_default(default)
    end

    :ok
  end

  # `harness/`+`keymap/` verbs are ONLY ever reached via `Harness.tools/2`
  # directly (a reaction's closed-over gaze/forest, or the read-only cell tier) —
  # NEVER merged into `SpellAgent.Tools.build_tools_map/0` (confirmed:
  # cell_tools_test.exs's own comment: "keymap/bind is a registry mutator; even
  # though Harness.tools defines it, [the cell tier denies it]"). `layout/`+
  # `view/` DO live in the main tools map (LayoutRegistry.tools/View.tools), so a
  # program exercising both surfaces needs both merged in, matching how a real
  # reaction runs (Reaction.Ptc merges Harness.tools into its own sandbox call).
  defp full_tools(forest \\ %{}, ui \\ nil) do
    SpellAgent.Harness.tools(forest, ui)
    |> Map.merge(SpellAgent.Tui.View.tools())
    |> Map.merge(LayoutRegistry.tools())
  end

  test "declare -> shadow with :focusable -> join the ring -> resolve a live-authored binding" do
    tools = full_tools()

    # 1. Declare a brand-new pane name — the ONE bounded meta-op.
    assert {:ok, step} =
             PtcRunner.Lisp.run(~s|(harness/declare-pane {:name "cost-histo"})|,
               tools: tools,
               caller: :in_process_v1
             )

    assert step.return["ok"] == true
    assert step.return["pane"] == "cost-histo"

    # 2. Shadow the body slot with a focusable widget under that name — 100%
    #    pre-existing PTC surface (view/ + layout/set), no new verb needed.
    src = ~s|
      (layout/set {:slot "detail"
                   :source (view/paragraph {:text "cost histogram"
                                             :tags {:focusable true}
                                             :block {:type "block" :title "cost" :borders ["all"]}})})
    |

    assert {:ok, _} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)

    # 3. Ui.safe_pane now recognizes the declared name — a gaze CAN focus it.
    assert Ui.safe_pane("cost-histo") == :"cost-histo"

    # 4. Bind + author a reaction under the declared name as context — the
    #    SAME homoiconic loop the compiled panes use, with zero Elixir change.
    assert {:ok, _} =
             PtcRunner.Lisp.run(
               ~s|(keymap/define-reaction {:context "cost-histo" :intent "app/toggle-cells" :source "(harness/expand {:id \\"x\\"})"})|,
               tools: tools,
               caller: :in_process_v1
             )

    assert {:ok, _} =
             PtcRunner.Lisp.run(
               ~s|(keymap/bind {:chord "z" :intent "app/toggle-cells" :context "cost-histo"})|,
               tools: tools,
               caller: :in_process_v1
             )

    # Resolve + dispatch through the REAL Keys pipeline with the declared
    # pane's OWN ATOM as the context (mirrors App.focus_stack/1's PLAN-024
    # clause for a runtime pane — no compiled module backs :"cost-histo").
    resolution = Keys.resolve(Chord.parse("z"), [:"cost-histo", Global])
    assert {:intent, :"app/toggle-cells", :"cost-histo"} = resolution

    ui = Ui.new(focus: :"cost-histo")
    result = Keys.dispatch(resolution, ui, %{})
    assert result.overrides["x"] == :expanded
  end

  test "an undeclared pane name never resolves (bounded, no accidental focus)" do
    assert Ui.safe_pane("never-declared-xyz") == nil
  end

  test "a declared pane joins Lens.focusables once shadowed with :focusable true" do
    tools = full_tools()

    {:ok, _} =
      PtcRunner.Lisp.run(~s|(harness/declare-pane {:name "sidebar"})|, tools: tools, caller: :in_process_v1)

    src = ~s|
      (layout/set {:slot "detail"
                   :source (view/paragraph {:text "hi" :tags {:focusable true}})})
    |

    {:ok, _} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)

    {:ok, shown} = LayoutRegistry.show("detail")
    assert shown["tags"]["focusable"] == true

    tree = LayoutRegistry.tree()
    assert "detail" in Lens.focusables(tree)
  end

  test "declare_pane rejects a malformed name and never grows the atom table" do
    tools = full_tools()

    # NB: the probe string must NEVER appear as an atom LITERAL anywhere in this
    # test's own compiled source (including in an assertion) — Elixir interns
    # atom literals into the module's constant pool at COMPILE time, so a name
    # like `:"Not Valid!!"` written elsewhere in this file would already exist
    # by the time this test runs, letting `define_pane`'s existing-atom-reuse
    # path (the same one that lets `KeymapRegistry.define_intent("true")`
    # succeed by reusing the pre-existing `true` atom) bypass the shape gate —
    # not a real bug, just an invalid probe. A dynamically-built string (never
    # written as a literal `:atom` anywhere) is the honest adversarial case.
    uniq = "Not Valid #{System.unique_integer([:positive])}!!"

    result =
      PtcRunner.Lisp.run(~s|(harness/declare-pane {:name "#{uniq}"})|,
        tools: tools,
        caller: :in_process_v1
      )

    assert {:ok, step} = result
    assert step.return["err"] =~ "rejected"
    assert_raise ArgumentError, fn -> String.to_existing_atom(uniq) end
  end
end
