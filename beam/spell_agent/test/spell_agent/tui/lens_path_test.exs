defmodule SpellAgent.Tui.LensPathTest do
  @moduledoc """
  Path-addressed surgical edits (PLAN-021 W2): `lens/update` + `lens/put`.

  Defends the contracts that make a path edit worth having over `layout/set`:
    * SIBLING PRESERVATION — editing one child leaves the others byte-identical
      (the whole reason not to resend a slot),
    * TWO-LEVEL LIVENESS — a `:fn`'s render-time `~hole` survives the edit and
      resolves live afterward (the edit doesn't freeze the UI),
    * `%` SUGAR — a bare `%` in the fn reads the current value (`data/current`),
    * the failure ladder — a path that doesn't resolve is rejected, no mutation,
    * the receipt is path-scoped (slot + path + hint), not a whole-tree echo.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{DefaultLayout, HoleResolver, LayoutRegistry, Tree, Ui}

  setup do
    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default_tree()})
      _ -> LayoutRegistry.seed_default(default_tree())
    end

    # Shadow `body` with a 3-child vertical split of paragraphs, so we have a
    # known multi-leaf subtree to address by index.
    three =
      %{
        "type" => "split",
        "slot" => "body",
        "dir" => "vertical",
        "children" => [
          %{"type" => "paragraph", "text" => "PANE-0"},
          %{"type" => "paragraph", "text" => "PANE-1"},
          %{"type" => "paragraph", "text" => "PANE-2"}
        ]
      }

    :ok = LayoutRegistry.set("body", three)
    tools = LayoutRegistry.tools()
    %{tools: tools}
  end

  defp default_tree do
    DefaultLayout.tree(Ui.new(panes: [:tree, :detail], focus: :tree), ["tree", "detail"])
  end

  defp quoted(src) do
    {:ok, step} = PtcRunner.Lisp.run(src)
    step.return
  end

  describe "lens/put — sibling preservation" do
    test "editing child 1's text leaves children 0 and 2 byte-identical", %{tools: tools} do
      {:ok, before} = LayoutRegistry.show("body")
      [c0_before, _c1, c2_before] = before["children"]

      result =
        tools["lens/put"].(%{
          "slot" => "body",
          "path" => [1, "text"],
          "value" => "EDITED"
        })

      assert result["ok"] == true
      refute Map.has_key?(result, "err")

      {:ok, after_} = LayoutRegistry.show("body")
      [c0_after, c1_after, c2_after] = after_["children"]

      # The addressed leaf changed...
      assert c1_after["text"] == "EDITED"
      # ...and ONLY it: the siblings are untouched, byte-for-byte.
      assert c0_after == c0_before
      assert c2_after == c2_before
    end

    test "the receipt is path-scoped: slot + path + hint, no whole-tree echo", %{tools: tools} do
      result =
        tools["lens/put"].(%{"slot" => "body", "path" => [0, "text"], "value" => "X"})

      assert result["slot"] == "body"
      assert result["path"] == [0, "text"]
      assert is_binary(result["hint"])
      # NOT a tree echo: the top-level frame node is never present in a receipt.
      refute result["slot"] == "frame"
      refute Map.has_key?(result, "children")
    end
  end

  describe "lens/update — fn over data/current" do
    test "the fn reads the current value via data/current", %{tools: tools} do
      result =
        tools["lens/update"].(%{
          "slot" => "body",
          "path" => [2, "text"],
          "fn" => quoted(~S'(quote (str "was: " data/current))')
        })

      assert result["ok"] == true
      {:ok, after_} = LayoutRegistry.show("body")
      assert Enum.at(after_["children"], 2)["text"] == "was: PANE-2"
    end

    test "a bare % is sugar for data/current", %{tools: tools} do
      result =
        tools["lens/update"].(%{
          "slot" => "body",
          "path" => [0, "text"],
          "fn" => quoted(~S'(quote (str % "!"))')
        })

      assert result["ok"] == true
      {:ok, after_} = LayoutRegistry.show("body")
      assert Enum.at(after_["children"], 0)["text"] == "PANE-0!"
    end
  end

  describe "lens/update — two-level liveness (the headline)" do
    test "a render-time ~hole in the fn survives the edit and resolves live after", %{tools: tools} do
      # The fn runs at EDIT time (data/current bound), but its result carries a
      # tmpl:: hole reading data/status — which must NOT resolve now. After the
      # edit, resolving the slot against a live bag makes the hole go live.
      # The canonical surface form: (quote (tmpl:: {… ~hole})) — quote defers the
      # whole fn to edit-time; the inner tmpl:: emits the live render hole.
      fn_form =
        quoted(~S'(quote (tmpl:: {:type "paragraph" :text ~(get data/status :turns)}))')

      result =
        tools["lens/update"].(%{"slot" => "body", "path" => [1], "fn" => fn_form})

      assert result["ok"] == true, inspect(result)

      {:ok, after_} = LayoutRegistry.show("body")
      child1 = Enum.at(Tree.children(after_), 1)

      # The edited child still contains an unresolved hole (it is LIVE, not baked).
      # `Tree.get` reads string OR atom keys: the fn's result is an atom-keyed map
      # (PTC map-literal eval), unlike the string-keyed siblings — the canonical
      # accessor is exactly what spans that difference.
      assert match?(%{"__hole__" => _}, Tree.get(child1, "text"))

      # Resolve against a live bag -> the hole goes live.
      live = HoleResolver.resolve_holes(child1, %{"status" => %{"turns" => 11}})
      assert Tree.get(live, "text") == 11

      # ...and against a DIFFERENT turn it re-resolves (not frozen to 11).
      live2 = HoleResolver.resolve_holes(child1, %{"status" => %{"turns" => 12}})
      assert Tree.get(live2, "text") == 12
    end
  end

  describe "result hints (the in-conversation steering surface)" do
    test "a lens edit receipt nudges toward the path-edit verbs", %{tools: tools} do
      result = tools["lens/put"].(%{"slot" => "body", "path" => [1, "text"], "value" => "X"})
      # The hint names the follow-up verb so the NEXT turn reaches for a surgical
      # edit, not a whole-slot resend.
      assert result["hint"] =~ "lens/update" or result["hint"] =~ "lens/put"
    end

    test "a layout/set receipt steers toward lens/update for the next tweak", %{tools: tools} do
      result =
        tools["layout/set"].(%{
          "slot" => "status",
          "source" => %{"type" => "paragraph", "text" => "HELLO"}
        })

      assert result["ok"] == true
      assert result["hint"] =~ "lens/update"
      # A compact receipt: confirmation + peek, never a whole-tree echo.
      refute Map.has_key?(result, "children")
    end

    test "no receipt leaks the __hole__ codec to the LLM", %{tools: tools} do
      # Set a templated (live-hole) slot, then read every string in the receipt:
      # the agent must never see raw `__hole__` codec maps — holes are an internal
      # representation, surfaced as `·` in the peek, not as codec.
      {:ok, step} =
        PtcRunner.Lisp.run(~S'(tmpl:: {:type "paragraph" :text ~(get data/status :label)})')

      result = tools["layout/set"].(%{"slot" => "status", "source" => step.return})
      refute inspect(result) =~ "__hole__"
    end
  end

  describe "failure ladder" do
    test "a path that does not resolve is rejected with no mutation", %{tools: tools} do
      {:ok, before} = LayoutRegistry.show("body")

      result =
        tools["lens/put"].(%{"slot" => "body", "path" => [9, "text"], "value" => "X"})

      assert result["reason"] == "path_missing"
      assert result["err"] =~ "does not resolve"

      {:ok, after_} = LayoutRegistry.show("body")
      assert after_ == before
    end

    test "an unknown slot is rejected", %{tools: tools} do
      result = tools["lens/put"].(%{"slot" => "nope", "path" => [0], "value" => "X"})
      assert result["err"] =~ "unknown slot" or result["reason"] == "path_missing"
    end

    test "a rewrite that breaks rendering is rejected; last-good kept", %{tools: tools} do
      {:ok, before} = LayoutRegistry.show("body")

      # Replace child 0 (a valid paragraph) with an unknown widget type -> the
      # rewritten body fails validation -> rejected, prior body kept.
      result =
        tools["lens/put"].(%{
          "slot" => "body",
          "path" => [0],
          "value" => %{"type" => "no_such_widget"}
        })

      assert result["reason"] == "bad_layout"

      {:ok, after_} = LayoutRegistry.show("body")
      assert after_ == before
    end
  end
end
