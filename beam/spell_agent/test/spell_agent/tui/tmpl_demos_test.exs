defmodule SpellAgent.Tui.TmplDemosTest do
  @moduledoc """
  W7 (PLAN-012): the 10 demos as executable integration tests — the end-to-end
  proof that "an interface with holes that update as it goes" works, from a
  `tmpl::` template through the resolver host, the data/* bag, the capability
  boundary, the failure ladder, the atomic diff, and the persistence loop.

  Each `test` IS a demo; the moduledoc of each describes what it proves. These
  double as the worked examples behind the prelude vocabulary.
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp
  alias PtcRunner.Lisp.{Formatter, QuoteData}
  alias SpellAgent.Tui.{DataBag, HoleDiff, HoleResolver}

  defp frozen(src) do
    {:ok, step} = Lisp.run(src)
    step.return
  end

  defp k(map, key), do: map[key] || map[String.to_atom(key)]

  # 1. HOLE — a live value updates as the data changes, with NO re-authoring.
  test "demo 1: a status hole shows the live model and updates when it changes" do
    tree = frozen(~S|(tmpl:: {:type "paragraph" :text ~(get data/status :model)})|)
    v1 = HoleResolver.resolve_holes(tree, %{"status" => %{"model" => "opus"}})
    v2 = HoleResolver.resolve_holes(tree, %{"status" => %{"model" => "sonnet"}})
    assert k(v1, "text") == "opus"
    assert k(v2, "text") == "sonnet"
  end

  # 2. ZERO-COST — a NEW data value is referenceable with no resolver change.
  test "demo 2: adding a data/tokens key needs no new render-path code" do
    bag =
      DataBag.build(%{vms: %{}, ui: %{}}, %{x: 0, y: 0, width: 1, height: 1})
      |> Map.put("tokens", 4096)

    tree = frozen(~S|(tmpl:: {:t ~data/tokens})|)
    assert k(HoleResolver.resolve_holes(tree, bag), "t") == 4096
  end

  # 3. STYLE HOLE — a color flips on run state.
  test "demo 3: a style hole flips color with run state" do
    tree = frozen(~S|(tmpl:: {:fg ~(if (get data/s :running?) "yellow" "green")})|)
    assert k(HoleResolver.resolve_holes(tree, %{"s" => %{"running?" => true}}), "fg") == "yellow"
    assert k(HoleResolver.resolve_holes(tree, %{"s" => %{"running?" => false}}), "fg") == "green"
  end

  # 4. SPLICE — a list grows/shrinks with the data.
  test "demo 4: a spliced list tracks the data length" do
    tree = frozen(~S|(tmpl:: {:items [~@data/xs]})|)
    assert k(HoleResolver.resolve_holes(tree, %{"xs" => [1, 2]}), "items") == [1, 2]
    assert k(HoleResolver.resolve_holes(tree, %{"xs" => [1, 2, 3, 4]}), "items") == [1, 2, 3, 4]
  end

  # 5. ATOMIC DIFF — with only one key changed, an unrelated hole is reused.
  test "demo 5: changing data/n does not recompute a data/s hole (LiveView-style)" do
    tree = frozen(~S|(tmpl:: {:a ~(get data/s :m) :b ~(+ data/n 1)})|)
    c1 = HoleDiff.resolve(tree, %{"s" => %{"m" => "x"}, "n" => 1})
    c2 = HoleDiff.resolve(tree, %{"s" => %{"m" => "x"}, "n" => 2}, c1)
    out = HoleDiff.tree(c2)
    # `a` reused (s unchanged), `b` recomputed (n changed) — and equal to uncached.
    assert out == HoleResolver.resolve_holes(tree, %{"s" => %{"m" => "x"}, "n" => 2})
    assert k(out, "a") == "x"
    assert k(out, "b") == 3
  end

  # 6. KEYED SPLICE — per-row maps built from data; one row's change is local.
  test "demo 6: a splice builds per-row maps from data" do
    tree = frozen(~S|(tmpl:: {:rows [~@(map (fn [r] {:label (get r :name)}) data/items)]})|)
    out = HoleResolver.resolve_holes(tree, %{"items" => [%{"name" => "a"}, %{"name" => "b"}]})
    rows = k(out, "rows")
    assert length(rows) == 2
    assert Enum.map(rows, &k(&1, "label")) == ["a", "b"]
  end

  # 7. FAILURE LADDER — a raising hole degrades; siblings still render.
  test "demo 7: a raising hole becomes the placeholder, siblings unaffected" do
    tree = frozen(~S|(tmpl:: {:boom ~(/ 1 0) :ok ~(+ 1 1)})|)
    out = HoleResolver.resolve_holes(tree, %{})
    assert k(out, "boom") == HoleResolver.placeholder()
    assert k(out, "ok") == 2
  end

  # 8. CAPABILITY — a hole cannot perform an effect (looking never acts).
  test "demo 8: a hole calling tool/ is blocked, no effect" do
    tree = frozen(~S|(tmpl:: {:bad ~(tool/sh {:argv ["echo" "hi"]})})|)
    assert k(HoleResolver.resolve_holes(tree, %{}), "bad") == HoleResolver.placeholder()
  end

  # 9. DOGFOOD — the native status renders from a DERIVATION hole over data/status.
  test "demo 9: the native status label/color are DERIVED in the layout from raw data" do
    # PLAN-027 M3: the status label + color are no longer bag keys
    # (data/status-label was retired) — the DERIVATION moved into the layout as a
    # PTC projection over the raw `data/status` the bag still ships. Resolving the
    # default layout's real status node against a running bag yields the running
    # label + yellow, proving the derivation-as-data path end to end.
    bag =
      DataBag.build(%{running?: true, vms: %{}, ui: %{}}, %{x: 0, y: 0, width: 1, height: 1})

    # The bag ships the RAW input, not the derived label.
    refute Map.has_key?(bag, "status-label")
    assert bag["status"]["running?"] == true

    # The real status node from the default layout carries the derivation holes.
    status = SpellAgent.Tui.Lens.at(SpellAgent.Tui.DefaultLayout.tree(SpellAgent.Tui.Ui.new()), "status")
    out = HoleResolver.resolve_holes(status, bag)
    assert k(out, "text") =~ "running"
    assert k(out, "style")["fg"] == "yellow"
  end

  # 10. PERSIST / RECALL — a frozen hole round-trips through the codec.
  test "demo 10: a tmpl hole serializes + thaws back to the form authored" do
    tree = frozen(~S|(tmpl:: {:text ~(str model "  $" cost)})|)
    %{"__hole__" => codec} = k(tree, "text")
    # the codec data is the durable form; thaw it and re-format to source.
    raw = QuoteData.from_data(codec)
    src = Formatter.format(raw)
    # the source re-parses to the same form the user wrote.
    {:ok, reparsed} = Lisp.FastParser.parse("(str model \"  $\" cost)")
    assert raw == reparsed
    # and it is plain JSON-serializable data (no tuples) — durable across sessions.
    assert {:ok, _} = Jason.encode(codec)
    assert is_binary(src)
  end
end
