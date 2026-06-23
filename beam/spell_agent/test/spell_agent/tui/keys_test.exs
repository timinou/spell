defmodule SpellAgent.Tui.KeysTest do
  @moduledoc """
  Unit tests for the resolver (PLAN-346 W1) — the chord→intent keymap cascade and
  the intent→gaze reaction dispatch. Proves the THREE orthogonal axes:
    1. contextual resolution (same chord, different intent by focus)
    2. live rebinding shadows the compiled keymap (without touching reactions)
    3. compiled reaction dispatch (without touching keymaps)
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{Chord, Keys, KeymapRegistry, Ui}
  alias SpellAgent.Tui.Keymap.Global

  # ---- two fake pane contexts with DIFFERENT intents for the SAME chord ----

  defmodule TreeCtx do
    use SpellAgent.Tui.Pane
    def context_name, do: :tree
    keymap([{"C-l", :"span/expand"}, {"C-h", :"span/contract"}, {"up", :"cursor/prev"}])
    @impl true
    def view(_), do: []
    @impl true
    def react(:"span/expand", ui, _f), do: Ui.expand(ui, "X")
    def react(:"span/contract", ui, _f), do: Ui.collapse(ui, "X")
    def react(:"cursor/prev", ui, _f), do: Ui.cursor(ui, -1)
    def react(_i, ui, _f), do: ui
  end

  defmodule AnswerCtx do
    use SpellAgent.Tui.Pane
    def context_name, do: :answer
    keymap([{"C-l", :"turn/next"}, {"C-h", :"turn/prev"}])
    @impl true
    def view(_), do: []
    @impl true
    def react(:"turn/next", ui, _f), do: Ui.turn(ui, :next)
    def react(:"turn/prev", ui, _f), do: Ui.turn(ui, :prev)
    def react(_i, ui, _f), do: ui
  end

  setup do
    KeymapRegistry.reset()
    :ok
  end

  defp name(ctx), do: ctx.context_name()

  describe "resolve/3 — the keymap cascade" do
    test "AXIS 1: the SAME chord resolves to a DIFFERENT intent by focus context" do
      cl = Chord.parse("C-l")
      assert {:intent, :"span/expand", TreeCtx} = Keys.resolve(cl, [TreeCtx, Global], &name/1)
      assert {:intent, :"turn/next", AnswerCtx} = Keys.resolve(cl, [AnswerCtx, Global], &name/1)
    end

    test "a chord the pane doesn't bind falls through to global" do
      cj = Chord.parse("C-j")
      assert {:intent, :"focus/next", Global} = Keys.resolve(cj, [TreeCtx, Global], &name/1)
    end

    test "the focused pane shadows global for a chord both bind" do
      # global binds esc->app/quit; give the pane its own esc to prove precedence
      KeymapRegistry.bind(:tree, Chord.parse("esc"), :"cursor/prev")

      assert {:intent, :"cursor/prev", TreeCtx} =
               Keys.resolve(Chord.parse("esc"), [TreeCtx, Global], &name/1)
    end

    test "an unbound chord resolves to :unbound (composer text sink)" do
      assert :unbound = Keys.resolve(Chord.parse("z"), [TreeCtx, Global], &name/1)
    end

    test "AXIS 2: a live registry binding SHADOWS the compiled keymap" do
      cl = Chord.parse("C-l")
      # compiled: C-l -> span/expand
      assert {:intent, :"span/expand", TreeCtx} = Keys.resolve(cl, [TreeCtx, Global], &name/1)
      # rebind live, reactions untouched
      KeymapRegistry.bind(:tree, cl, :"span/contract")
      assert {:intent, :"span/contract", TreeCtx} = Keys.resolve(cl, [TreeCtx, Global], &name/1)
      # unbind reveals the compiled binding again
      KeymapRegistry.unbind(:tree, cl)
      assert {:intent, :"span/expand", TreeCtx} = Keys.resolve(cl, [TreeCtx, Global], &name/1)
    end
  end

  describe "context_name/1 — load-safe (BUG-006)" do
    test "resolves context_name/0 even when the module is UNLOADED (on-disk beam)" do
      # The bug: function_exported?/3 is FALSE for a module the BEAM hasn't lazily
      # loaded yet, so context_name/1 must ensure_loaded? FIRST or it drops to the
      # module fallback. Use a REAL pane module (it has a .beam on disk, so it
      # reloads): purge it to force the not-loaded state, then resolve.
      mod = SpellAgent.Tui.Panes.SpanTree
      :code.purge(mod)
      :code.delete(mod)

      refute :erlang.function_exported(mod, :context_name, 0),
             "precondition: module must be unloaded for this to test the guard"

      # Without the ensure_loaded? guard this returns the MODULE; with it, :tree.
      assert Keys.context_name(mod) == :tree
    end

    test "uses context_name/0 for a loaded module that exports it (Global -> :global)" do
      assert Keys.context_name(Global) == :global
    end

    test "falls back to the module itself when it exports no context_name/0" do
      # An arbitrary module with no context_name/0 is its own key.
      assert Keys.context_name(Enum) == Enum
    end
  end

  describe "dispatch/4 — the reaction cascade" do
    test "AXIS 3: compiled reaction transforms the gaze" do
      ui = Ui.new()
      res = Keys.resolve(Chord.parse("C-l"), [TreeCtx, Global], &name/1)
      ui2 = Keys.dispatch(res, ui, %{}, &name/1)
      assert ui2.overrides == %{"X" => :expanded}
    end

    test "the SAME chord dispatches to different gaze changes by context" do
      ui = Ui.new()
      tree_res = Keys.resolve(Chord.parse("C-l"), [TreeCtx, Global], &name/1)
      ans_res = Keys.resolve(Chord.parse("C-l"), [AnswerCtx, Global], &name/1)
      assert Keys.dispatch(tree_res, ui, %{}, &name/1).overrides == %{"X" => :expanded}
      assert Keys.dispatch(ans_res, ui, %{}, &name/1).turn == 1
    end

    test "global focus/next dispatches via the Global context's react/3" do
      ui = Ui.new(panes: [:tree, :answer], focus: :tree)
      res = Keys.resolve(Chord.parse("C-j"), [TreeCtx, Global], &name/1)
      assert Keys.dispatch(res, ui, %{}, &name/1).focus == :answer
    end

    test ":unbound dispatch is identity" do
      ui = Ui.new()
      assert Keys.dispatch(:unbound, ui, %{}, &name/1) == ui
    end

    test "C-e toggles the cells-drawer flag via the global keymap" do
      ui = Ui.new()
      res = Keys.resolve(Chord.parse("C-e"), [Global], &name/1)
      assert {:intent, :"app/toggle-cells", Global} = res
      ui1 = Keys.dispatch(res, ui, %{}, &name/1)
      assert ui1.flags["cells-drawer"] == true
      # toggle again -> off
      ui2 = Keys.dispatch(res, ui1, %{}, &name/1)
      assert ui2.flags["cells-drawer"] == false
    end

    test "axes are independent: rebinding a key changes WHICH reaction fires, not the reactions" do
      ui = Ui.new()
      # rebind C-l to the contract intent; dispatch now collapses, expand reaction untouched
      KeymapRegistry.bind(:tree, Chord.parse("C-l"), :"span/contract")
      res = Keys.resolve(Chord.parse("C-l"), [TreeCtx, Global], &name/1)
      assert Keys.dispatch(res, ui, %{}, &name/1).overrides == %{"X" => :collapsed}
    end
  end
end
