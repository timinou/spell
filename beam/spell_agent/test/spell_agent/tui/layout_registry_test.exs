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
      assert {:error, {:bad_layout, "status"}} =
               LayoutRegistry.set("status", %{"type" => "no_such_widget", "slot" => "status"})

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
      assert {:error, {:bad_layout, "status"}} = LayoutRegistry.set("status", bad)

      assert {:ok, shown} = LayoutRegistry.show("status")
      assert shown["text"] == "GOOD"
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

    test "layout/tree returns the whole live tree" do
      tools = LayoutRegistry.tools()
      t = tools["layout/tree"].(%{})
      assert t["slot"] == "frame"
    end
  end
end
