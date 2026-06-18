defmodule SpellAgent.HarnessTest do
  @moduledoc """
  Tests for the harness/ + keymap/ PTC-Lisp surfaces (PLAN-346 W3) — the
  homoiconic capstone. Proves the two sibling namespaces evaluate through the
  vendored ptc_runner SPELL PATCH, that a reaction is a pure gaze fold, and that
  keymap/ meta-ops rebind the live registry.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Harness
  alias SpellAgent.Tui.{Chord, KeymapRegistry, Reaction, Ui}
  alias SpellAgent.Tui.Store.Span

  setup do
    # The app supervises a session-global KeymapRegistry; start one if the app
    # isn't running (isolated test), else reuse + reset it.
    case Process.whereis(KeymapRegistry) do
      nil -> start_supervised!(KeymapRegistry)
      _pid -> :ok
    end

    KeymapRegistry.reset()
    :ok
  end

  defp forest do
    %{
      "root" => %Span{id: "root", parent_id: nil, kind: :run, status: :ok, label: "r", children: ["c"]},
      "c" => %Span{id: "c", parent_id: "root", kind: :tool, status: :ok, label: "t", children: ["g"]},
      "g" => %Span{id: "g", parent_id: "c", kind: :llm, status: :ok, label: "llm"}
    }
  end

  defp tree_ui, do: Ui.new(focus: :tree, auto_depth: 10) |> Map.put(:cursors, %{tree: 0})

  describe "harness/ namespace evaluates through ptc_runner" do
    test "(harness/expand) marks the cursor span expanded" do
      tools = Harness.tools(forest(), tree_ui())
      {:ok, step} = PtcRunner.Lisp.run("(harness/expand {})", tools: tools, caller: :in_process_v1)
      assert step.return["overrides"] == %{"root" => "expanded"}
    end

    test "(harness/turn) advances the turn index" do
      tools = Harness.tools(forest(), tree_ui())
      {:ok, step} = PtcRunner.Lisp.run("(harness/turn {:dir \"next\"})", tools: tools, caller: :in_process_v1)
      assert step.return["turn"] == 1
    end

    test "(harness/cursor-id) resolves the span under the tree cursor" do
      tools = Harness.tools(forest(), tree_ui())
      {:ok, step} = PtcRunner.Lisp.run("(harness/cursor-id)", tools: tools, caller: :in_process_v1)
      assert step.return == "root"
    end

    test "(harness/descendants id) walks the forest below a span" do
      tools = Harness.tools(forest(), tree_ui())
      {:ok, step} = PtcRunner.Lisp.run("(harness/descendants {:id \"root\"})", tools: tools, caller: :in_process_v1)
      assert Enum.sort(step.return) == ["c", "g"]
    end

    test "harness/ is a sibling namespace, NOT under tool/ (call resolves)" do
      # If harness/ weren't a real namespace, the analyzer would reject it. The
      # successful runs above prove dispatch; here we assert the error path for a
      # bogus harness verb is a namespaced 'unknown' (recognized namespace).
      tools = Harness.tools(forest(), tree_ui())
      assert {:error, _} = PtcRunner.Lisp.run("(harness/nonexistent {})", tools: tools, caller: :in_process_v1)
    end
  end

  describe "Reaction.Ptc — a reaction is a pure gaze fold" do
    test "expand the cursor span and round-trip back to %Ui{}" do
      result = Reaction.Ptc.run("(harness/expand {})", tree_ui(), forest())
      assert %Ui{} = result
      assert result.overrides == %{"root" => :expanded}
    end

    test "expand-all: a reduce over descendants (the homoiconic showpiece)" do
      src =
        "(reduce (fn [acc id] (harness/expand {:ui acc :id id})) data/ui " <>
          "(harness/descendants {:id (harness/cursor-id)}))"

      result = Reaction.Ptc.run(src, tree_ui(), forest())
      # cursor is on root; its descendants c + g are expanded.
      assert result.overrides["c"] == :expanded
    end

    test "a broken reaction degrades to the unchanged gaze (fail-safe)" do
      ui = tree_ui()
      # references an unbound var -> program error -> identity.
      assert Reaction.Ptc.run("(harness/expand {:id no_such_var})", ui, forest()) == ui
    end

    test "a non-map return leaves the gaze untouched" do
      ui = tree_ui()
      assert Reaction.Ptc.run("42", ui, forest()) == ui
    end
  end

  describe "keymap/ namespace — live rebinding meta-ops" do
    test "(keymap/bind …) writes a live binding the registry reflects" do
      tools = Harness.tools(forest(), tree_ui())

      {:ok, _} =
        PtcRunner.Lisp.run(
          "(keymap/bind {:chord \"C-l\" :intent \"span/expand\" :context \"tree\"})",
          tools: tools,
          caller: :in_process_v1
        )

      assert KeymapRegistry.lookup_binding(:tree, Chord.parse("C-l")) == :"span/expand"
    end

    test "(keymap/show …) returns the live keymap as data" do
      KeymapRegistry.bind(:tree, Chord.parse("x"), :"span/toggle")
      tools = Harness.tools(forest(), tree_ui())
      {:ok, step} = PtcRunner.Lisp.run("(keymap/show {:context \"tree\"})", tools: tools, caller: :in_process_v1)
      assert %{"chord" => "x", "intent" => "span/toggle"} in step.return
    end

    test "(keymap/define-reaction …) stores a reaction the registry can run" do
      tools = Harness.tools(forest(), tree_ui())

      {:ok, _} =
        PtcRunner.Lisp.run(
          ~s|(keymap/define-reaction {:context "tree" :intent "span/expand-all" :doc "expand subtree" :source "(harness/expand {})"})|,
          tools: tools,
          caller: :in_process_v1
        )

      assert KeymapRegistry.lookup_reaction(:tree, :"span/expand-all") == "(harness/expand {})"
    end

    test "define-reaction rejects invalid PTC source" do
      tools = Harness.tools(forest(), tree_ui())

      assert {:error, _} =
               PtcRunner.Lisp.run(
                 ~s|(keymap/define-reaction {:context "tree" :intent "bad" :source "(this is not valid ptc"})|,
                 tools: tools,
                 caller: :in_process_v1
               )
    end
  end

  describe "atom-table-DoS defenses (PLAN-346 W3r)" do
    test "an unknown harness/ verb is rejected WITHOUT interning a new atom" do
      tools = Harness.tools(forest(), tree_ui())
      bogus = "harness_dos_#{System.unique_integer([:positive])}"
      src = "(harness/#{bogus} {})"
      # The analyzer rejects it; crucially the qualified name is never interned.
      assert {:error, _} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert_raise ArgumentError, fn -> String.to_existing_atom("harness/#{bogus}") end
    end

    test "a reaction returning an arbitrary focus string does NOT intern it" do
      uniq = "pane_dos_#{System.unique_integer([:positive])}"
      ui = tree_ui()
      # The reaction returns a gaze map with a bogus focus; rehydrate must keep the
      # prior focus and never create the atom.
      result = Reaction.Ptc.run(~s|{"focus" "#{uniq}"}|, ui, forest())
      assert result.focus == ui.focus
      assert_raise ArgumentError, fn -> String.to_existing_atom(uniq) end
    end

    test "keymap/bind rejects an unknown intent without interning it" do
      uniq = "intent_dos_#{System.unique_integer([:positive])}"
      tools = Harness.tools(forest(), tree_ui())
      src = ~s|(keymap/bind {:chord "z" :intent "#{uniq}/x" :context "tree"})|
      assert {:error, _} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      assert_raise ArgumentError, fn -> String.to_existing_atom("#{uniq}/x") end
    end

    test "keymap/bind rejects an unknown context" do
      tools = Harness.tools(forest(), tree_ui())
      src = ~s|(keymap/bind {:chord "z" :intent "span/expand" :context "bogus_ctx"})|
      assert {:error, _} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
    end

    test "define-reaction rejects an intent that isn't domain/verb shaped" do
      tools = Harness.tools(forest(), tree_ui())
      src = ~s|(keymap/define-reaction {:context "tree" :intent "NotValidShape!!" :source "(harness/expand {})"})|
      assert {:error, _} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
    end

    test "a reaction returning a non-integer auto_depth keeps the prior value (no corrupt gaze)" do
      ui = %{tree_ui() | auto_depth: 3}
      result = Reaction.Ptc.run(~s|{"auto_depth" "not-an-int"}|, ui, forest())
      assert result.auto_depth == 3
      # And it stays a usable gaze: expanded?/3 (numeric compare) doesn't crash.
      assert is_boolean(SpellAgent.Tui.Ui.expanded?(result, 0, "root"))
    end

    test "keymap/bind rejects answer/prompt contexts (resolver uses turn_nav) — final-review P2" do
      tools = Harness.tools(forest(), tree_ui())
      # :answer is NOT a resolver context; binding there would be silently inert.
      src = ~s|(keymap/bind {:chord "z" :intent "turn/next" :context "answer"})|
      assert {:error, _} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      # turn_nav IS valid (the answer/prompt panes resolve through it).
      ok = ~s|(keymap/bind {:chord "z" :intent "turn/next" :context "turn_nav"})|
      assert {:ok, _} = PtcRunner.Lisp.run(ok, tools: tools, caller: :in_process_v1)
    end

    test "define-reaction rejects an overlong intent name without crashing the registry — final-review P2" do
      tools = Harness.tools(forest(), tree_ui())
      long = "d/" <> String.duplicate("x", 300)
      src = ~s|(keymap/define-reaction {:context "tree" :intent "#{long}" :source "(harness/expand {})"})|
      assert {:error, _} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      # The registry survived (didn't crash/restart): a normal op still works.
      assert KeymapRegistry.lookup_binding(:tree, Chord.parse("q")) == nil
    end
  end

  describe "the homoiconic loop closes: define a reaction, bind it, dispatch it" do
    test "an authored reaction drives the gaze when its bound chord fires" do
      # 1. Author a reaction as data.
      KeymapRegistry.put_reaction(:tree, :"span/expand-all", "(harness/expand {})")
      # 2. Bind a chord to its intent.
      KeymapRegistry.bind(:tree, Chord.parse("E"), :"span/expand-all")

      # 3. Resolve + dispatch the chord through the full Keys pipeline.
      alias SpellAgent.Tui.Keys
      alias SpellAgent.Tui.Keymap.Global

      resolution = Keys.resolve(Chord.parse("E"), [tree_context(), Global])
      assert {:intent, :"span/expand-all", _} = resolution

      result = Keys.dispatch(resolution, tree_ui(), forest())
      assert result.overrides["root"] == :expanded
    end
  end

  # A minimal context module exposing :tree as its registry name + a keymap, so
  # Keys.resolve treats it like the real SpanTree context.
  defp tree_context, do: SpellAgent.Tui.Panes.SpanTree
end
