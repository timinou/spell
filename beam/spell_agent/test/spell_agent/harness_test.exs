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

    test "run/4 merges lens/* into the tools map when a tree is given (PLAN-024 Wave 2)" do
      tree = %{
        "type" => "split",
        "dir" => "horizontal",
        "constraints" => [["percentage", 50], ["percentage", 50]],
        "children" => [
          %{"type" => "pane", "slot" => "tree", "tags" => %{}},
          %{"type" => "pane", "slot" => "detail", "tags" => %{}}
        ]
      }

      result =
        Reaction.Ptc.run(
          ~S|(harness/focus {:dir (lens/frame-target {:dir "right"})})|,
          tree_ui(),
          forest(),
          tree
        )

      assert result.focus == :detail
    end

    test "run/3 (no tree, the pre-Wave-2 arity) never exposes lens/* — unknown tool degrades safely" do
      ui = tree_ui()

      result =
        Reaction.Ptc.run(~S|(harness/focus {:dir (lens/frame-target {:dir "right"})})|, ui, forest())

      assert result == ui
    end

    test "run/5 merges black/* into the tools map when mesh_opts is given (PLAN-024 Wave 3)" do
      region = "reaction-mesh-#{System.unique_integer([:positive])}"

      case Process.whereis(SpellAgent.Hist.Store.Memory) do
        nil -> start_supervised!(SpellAgent.Hist.Store.Memory)
        _ -> :ok
      end

      mesh_opts = %{session_id: "agent", region: region, store: SpellAgent.Hist.Store.Memory}

      source = ~S|{"focus" (get (black/post {:kind "finding" :payload {:x 1}}) "kind")}|
      result = Reaction.Ptc.run(source, tree_ui(), forest(), nil, mesh_opts)

      # black/post ran (its return's "kind" key fed back into the gaze's focus
      # field, coerced through Ui.safe_pane — "finding" isn't a known pane so the
      # gaze's focus stays unchanged, but the absence of a crash + the record
      # actually landing on the mesh store IS the proof black/* was reachable).
      assert %SpellAgent.Tui.Ui{} = result

      records = SpellAgent.Mesh.Store.by_kind(SpellAgent.Hist.Store.Memory, region, :finding)
      assert length(records) == 1
    end

    test "run/4 (no mesh_opts, the pre-Wave-3 arity) never exposes black/* — unknown tool degrades safely" do
      ui = tree_ui()
      result = Reaction.Ptc.run(~S|(black/post {:kind "finding" :payload {}})|, ui, forest())
      assert result == ui
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
      # :answer is NOT a resolver context (W5 renamed it to :detail); a bind there
      # would be silently inert, so it's rejected.
      src = ~s|(keymap/bind {:chord "z" :intent "span/expand" :context "answer"})|
      assert {:error, _} = PtcRunner.Lisp.run(src, tools: tools, caller: :in_process_v1)
      # :tree IS a resolver context; span/expand is a real compiled intent there.
      ok = ~s|(keymap/bind {:chord "z" :intent "span/expand" :context "tree"})|
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

  describe "modal mode round-trips through a reaction (W5r)" do
    test "a reaction can set the mode, and it survives the round-trip" do
      ui = tree_ui()
      assert ui.mode == :normal
      # A reaction returns a gaze with mode flipped to insert.
      result = Reaction.Ptc.run(~s|{"mode" "insert" "focus" "prompt"}|, ui, forest())
      assert result.mode == :insert
      assert result.focus == :prompt
    end

    test "an invalid mode string is coerced away (never interned), keeps prior" do
      ui = %{tree_ui() | mode: :insert}
      result = Reaction.Ptc.run(~s|{"mode" "bogus_mode_xyz"}|, ui, forest())
      assert result.mode == :insert
      assert_raise ArgumentError, fn -> String.to_existing_atom("bogus_mode_xyz") end
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
