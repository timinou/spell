defmodule SpellAgent.Tui.LayoutRegistryTest do
  @moduledoc """
  The canonical layout tree (PLAN-009): the render mirror as live data.

  Defends:
    * the default tree is seeded and readable,
    * a slot shadow REPLACES that subtree and survives round-trip,
    * the failure ladder REJECTS a non-renderable shadow (last-good kept),
    * an unknown slot is rejected,
    * reset restores the default subtree,
    * the layout/ PTC surface (set/show/tree/reset) drives all of it.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{DefaultLayout, LayoutRegistry, Ui}

  setup do
    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default_tree()})
      _ -> LayoutRegistry.seed_default(default_tree())
    end

    :ok
  end

  defp default_tree do
    DefaultLayout.tree(Ui.new(panes: [:tree, :detail], focus: :tree), ["tree", "detail"])
  end

  describe "seed + read" do
    test "the seeded default tree has the frame + body + panes" do
      t = LayoutRegistry.tree()
      assert {:ok, _frame} = LayoutRegistry.show("frame")
      assert {:ok, _status} = LayoutRegistry.show("status")
      assert {:ok, _body} = LayoutRegistry.show("body")
      assert SpellAgent.Tui.Lens.focusables(t) == ["tree", "detail"]
    end
  end

  describe "slot shadowing + failure ladder" do
    test "a valid widget shadow replaces the status slot" do
      node = %{"type" => "paragraph", "slot" => "status", "text" => "CUSTOM"}
      assert :ok = LayoutRegistry.set("status", node)
      assert {:ok, shown} = LayoutRegistry.show("status")
      assert shown["text"] == "CUSTOM"
    end

    test "an unknown slot is rejected" do
      assert {:error, {:unknown_slot, "nope"}} =
               LayoutRegistry.set("nope", %{"type" => "paragraph", "text" => "x"})
    end

    test "a non-renderable shadow is rejected; the prior subtree is kept (last-good)" do
      # First install a known-good shadow.
      :ok =
        LayoutRegistry.set("status", %{
          "type" => "paragraph",
          "slot" => "status",
          "text" => "GOOD"
        })

      # Then attempt garbage: a node of an unknown widget type can't materialize,
      # and as the SOLE slot content yields no placements -> rejected.
      assert {:error, {:bad_layout, "status", diagnostic}} =
               LayoutRegistry.set("status", %{"type" => "no_such_widget", "slot" => "status"})

      assert diagnostic["path"] == "source.type"
      assert diagnostic["reason"] == "unknown_widget"
      assert diagnostic["detail"] =~ "no_such_widget"

      # last-good preserved.
      assert {:ok, shown} = LayoutRegistry.show("status")
      assert shown["text"] == "GOOD"
    end

    test "reset restores the slot to the default" do
      :ok =
        LayoutRegistry.set("status", %{"type" => "paragraph", "slot" => "status", "text" => "X"})

      assert :ok = LayoutRegistry.reset("status")
      {:ok, shown} = LayoutRegistry.show("status")
      refute shown["text"] == "X"
    end

    test "a shadow with an invalid boolean widget field is rejected with a field diagnostic" do
      :ok =
        LayoutRegistry.set("status", %{
          "type" => "paragraph",
          "slot" => "status",
          "text" => "GOOD"
        })

      bad = %{"type" => "paragraph", "slot" => "status", "text" => "BAD", "wrap" => "word"}

      assert {:error, {:bad_layout, "status", diagnostic}} = LayoutRegistry.set("status", bad)
      assert diagnostic["path"] == "source.wrap"
      assert diagnostic["reason"] == "invalid_field"
      assert diagnostic["field"] == "wrap"
      assert diagnostic["expected_type"] == "boolean"
      assert diagnostic["actual_type"] == "string"
      assert diagnostic["actual_value"] == "\"word\""
      assert diagnostic["detail"] =~ "expected boolean"
      assert diagnostic["expected"] =~ "true"
      assert diagnostic["expected"] =~ "false"
      assert diagnostic["hint"] =~ "omit"

      assert {:ok, shown} = LayoutRegistry.show("status")
      assert shown["text"] == "GOOD"
    end

    # BUG-008: a shadow that MATERIALIZES to a struct but cannot ENCODE through the
    # Bridge (a poisoned field that only raises at draw time) must be rejected by
    # the failure ladder -- NOT installed to crash the live render every frame.
    # This is distinct from the unknown-widget case above (which fails to
    # materialize at all); here the struct builds but the Bridge refuses it.
    test "a shadow that builds but fails to ENCODE is rejected (last-good kept)" do
      :ok =
        LayoutRegistry.set("status", %{
          "type" => "paragraph",
          "slot" => "status",
          "text" => "GOOD"
        })

      # A sparkline with non-numeric data materializes to a %Sparkline{} but the
      # Bridge raises when encoding it.
      bad = %{"type" => "sparkline", "slot" => "status", "data" => ["not", "numbers"]}
      assert match?(%{__struct__: _}, SpellAgent.Tui.Materialize.to_struct(bad))
      assert {:error, {:bad_layout, "status", diagnostic}} = LayoutRegistry.set("status", bad)
      assert diagnostic["reason"] == "encode_failed"
      assert diagnostic["path"] == "source"

      assert {:ok, shown} = LayoutRegistry.show("status")
      assert shown["text"] == "GOOD"
    end

    # REGRESSION (PROJ-005): a tmpl:: template whose holes reference data/* keys
    # absent from the probe's EMPTY env must NOT be rejected. Before the
    # nil->placeholder fix in HoleResolver.eval_hole, every data-hole resolved to
    # nil, which failed to materialize/encode -> :bad_layout -> the agent could
    # never install a templated slot, so cells and any live data never reached
    # the screen. The probe must validate the SKELETON's shape, treating a
    # missing-data hole as the `·` placeholder (valid text), not nil.
    test "a tmpl:: template with data holes is accepted (holes degrade, not reject)" do
      {:ok, step} =
        PtcRunner.Lisp.run(~S'(tmpl:: {:type "paragraph" :text ~(get data/status :label)})')

      assert :ok = LayoutRegistry.set("status", step.return)

      # The frozen template was installed (not last-good): the slot now carries a
      # __hole__ leaf, which resolves to the placeholder against empty data.
      assert {:ok, shown} = LayoutRegistry.show("status")
      resolved = SpellAgent.Tui.HoleResolver.resolve_holes(shown, %{})
      assert resolved[:text] == "·"
    end
  end

  describe "layout/ PTC surface" do
    test "layout/set then layout/show round-trips a shadow" do
      tools = LayoutRegistry.tools()

      set = tools["layout/set"]
      show = tools["layout/show"]

      result =
        set.(%{"slot" => "status", "source" => %{"type" => "paragraph", "text" => "VIA-PTC"}})

      refute Map.has_key?(result, "err")

      shown = show.(%{"slot" => "status"})
      assert shown["text"] == "VIA-PTC"
    end

    test "layout/set reports slot, path, and reason for a bad frame source" do
      tools = LayoutRegistry.tools()
      set = tools["layout/set"]

      result = set.(%{"slot" => "frame", "source" => %{"type" => "frame"}})

      assert result["reason"] == "bad_layout"
      assert result["slot"] == "frame"
      assert result["diagnostic"]["path"] == "source.type"
      assert result["diagnostic"]["reason"] == "unknown_widget"
      assert result["err"] =~ "bad layout for slot \"frame\""
      assert result["err"] =~ "unknown widget type \"frame\""
    end

    test "layout/set reports actionable field errors for invalid boolean fields" do
      tools = LayoutRegistry.tools()
      set = tools["layout/set"]

      result =
        set.(%{
          "slot" => "status",
          "source" => %{"type" => "paragraph", "text" => "BAD", "wrap" => "word"}
        })

      assert result["reason"] == "bad_layout"
      assert result["slot"] == "status"
      assert result["diagnostic"]["path"] == "source.wrap"
      assert result["diagnostic"]["reason"] == "invalid_field"
      assert result["diagnostic"]["actual_type"] == "string"
      assert result["err"] =~ "source.wrap"
      assert result["err"] =~ "expected boolean"
      assert result["err"] =~ "\"word\""
      assert result["err"] =~ "true"
      assert result["err"] =~ "false"
    end

    test "layout/tree returns the whole live tree" do
      tools = LayoutRegistry.tools()
      t = tools["layout/tree"].(%{})
      assert t["slot"] == "frame"
    end

    # FEAT-022 (PLAN-017): a successful set folds a best-effort ASCII `peek` of
    # the just-set node into the result, so the agent can confirm rendering inline
    # instead of asserting success without evidence.
    test "layout/set carries a peek of the just-set node on success" do
      tools = LayoutRegistry.tools()

      result =
        tools["layout/set"].(%{
          "slot" => "status",
          "source" => %{"type" => "paragraph", "text" => "PEEK-ME"}
        })

      refute Map.has_key?(result, "err")
      assert result["peek"] =~ "PEEK-ME"
    end

    test "layout/set omits peek (but still succeeds) for a node that can't render standalone" do
      tools = LayoutRegistry.tools()

      result =
        tools["layout/set"].(%{
          "slot" => "status",
          "source" => %{"type" => "pane", "pane" => "x", "focusable" => true}
        })

      refute Map.has_key?(result, "err")
      refute Map.has_key?(result, "peek")
    end

    # BUG-013 (PLAN-017): a bare `(str … ~x …)` inside tmpl:: is delivered to the
    # agent as a named `unevaluated_form` diagnostic, not an opaque encode error.
    test "layout/set reports unevaluated_form for a bare (str …) inside tmpl::" do
      tools = LayoutRegistry.tools()

      {:ok, step} =
        PtcRunner.Lisp.run(
          ~S'(tmpl:: {:type "paragraph" :text (str "turn " ~(get data/status :label))})'
        )

      result = tools["layout/set"].(%{"slot" => "status", "source" => step.return})

      assert result["reason"] == "bad_layout"
      assert result["diagnostic"]["reason"] == "unevaluated_form"
      assert result["diagnostic"]["detail"] =~ "str"
      assert result["err"] =~ "unevaluated_form"
    end
  end
end
