defmodule SpellAgent.Tui.DataBagTest do
  @moduledoc """
  W4 contract (PLAN-012): the generic `data/*` bag — the zero-cost seam.

  Pins: the documented key set + shapes, the fine-grained scalar keys (§8c.3),
  totality on degenerate state, and the CENTRAL CLAIM — a NEW value is
  referenceable by a hole with no change to the resolver or render path (cost
  scales with bag keys, not holes).
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.{DataBag, HoleResolver}
  alias PtcRunner.Lisp

  defp area, do: %{x: 0, y: 0, width: 80, height: 24}

  # A minimal but realistic render-state map (no live Store — safe_spans degrades).
  defp state(overrides \\ %{}) do
    Map.merge(
      %{
        running?: false,
        result: nil,
        composer: "",
        last_prompt: nil,
        vms: %{},
        ui: %{focus: :tree, mode: :normal, turn: 0}
      },
      overrides
    )
  end

  describe "bag shape" do
    test "carries the documented coarse keys" do
      bag = DataBag.build(state(), area())
      for key <- ["area", "status", "ui", "vms", "forest"], do: assert(Map.has_key?(bag, key))
    end

    test "carries the fine-grained scalar keys (§8c.3)" do
      bag = DataBag.build(state(), area())

      for key <- ["running?", "turns", "tools", "forest-count", "composer"],
          do: assert(Map.has_key?(bag, key))
    end

    test "area reflects the frame rect" do
      bag = DataBag.build(state(), %{x: 1, y: 2, width: 100, height: 40})
      assert bag["area"] == %{"x" => 1, "y" => 2, "width" => 100, "height" => 40}
    end

    test "status reflects run state" do
      bag = DataBag.build(state(%{running?: true}), area())
      assert bag["status"]["running?"] == true
      assert bag["running?"] == true
    end

    test "result is tagged ok/error/nil" do
      assert DataBag.build(state(%{result: {:ok, 1}}), area())["status"]["result"] == "ok"
      assert DataBag.build(state(%{result: {:error, :x}}), area())["status"]["result"] == "error"
      assert DataBag.build(state(%{result: nil}), area())["status"]["result"] == nil
    end
  end

  describe "sanitization (capability boundary, W3/W4 review #1)" do
    test "a function value anywhere in state is stripped from the bag" do
      f = fn _ -> :PWNED end
      bag = DataBag.build(state(%{vms: %{"p" => %{"cb" => f, "name" => "ok"}}}), area())
      # the vms map is exposed, but the fn within is gone (nil), the data kept.
      assert get_in(bag, ["vms", "p", "cb"]) == nil
      assert get_in(bag, ["vms", "p", "name"]) == "ok"
    end

    test "a pid/ref is stripped" do
      bag = DataBag.build(state(%{vms: %{"p" => %{"pid" => self()}}}), area())
      assert get_in(bag, ["vms", "p", "pid"]) == nil
    end

    test "a hole cannot recover an executable from the bag" do
      f = fn _ -> :PWNED end
      bag = DataBag.build(state(%{vms: %{"p" => %{"cb" => f}}}), area())
      {:ok, frozen} = Lisp.run(~S|(tmpl:: {:x ~(get (get data/vms "p") :cb)})|)
      tree = HoleResolver.resolve_holes(frozen.return, bag)
      # the callback is nil in the bag; the hole resolves to nil, never a fn.
      refute is_function(tree[:x] || tree["x"])
    end
  end

  describe "totality" do
    test "an empty state map degrades, never raises" do
      assert %{} = DataBag.build(%{}, area())
    end

    test "a nil area degrades to a zero rect" do
      bag = DataBag.build(state(), nil)
      assert bag["area"] == %{"x" => 0, "y" => 0, "width" => 0, "height" => 0}
    end
  end

  # ============================================================
  # the zero-cost claim — a hole resolves any bag key uniformly
  # ============================================================

  describe "holes resolve against the bag (the seam works)" do
    test "a hole reads a coarse key" do
      bag = DataBag.build(state(%{running?: true}), area())
      {:ok, frozen} = Lisp.run(~S|(tmpl:: {:x ~(get data/status :running?)})|)
      tree = HoleResolver.resolve_holes(frozen.return, bag)
      assert (tree[:x] || tree["x"]) == true
    end

    test "a hole reads a fine-grained scalar key" do
      bag = DataBag.build(state(), area())
      {:ok, frozen} = Lisp.run(~S|(tmpl:: {:c ~data/forest-count})|)
      tree = HoleResolver.resolve_holes(frozen.return, bag)
      assert (tree[:c] || tree["c"]) == 0
    end

    test "ZERO-COST: a NEW bag key is referenceable with no resolver change" do
      # The central property: extend the bag with one key; a hole references it
      # through the SAME generic resolve path — no new render-path Elixir.
      bag = DataBag.build(state(), area()) |> Map.put("tokens", 1234)
      {:ok, frozen} = Lisp.run(~S|(tmpl:: {:t ~data/tokens})|)
      tree = HoleResolver.resolve_holes(frozen.return, bag)
      assert (tree[:t] || tree["t"]) == 1234
    end
  end
end
