defmodule SpellAgent.Tui.HoleResolverTest do
  @moduledoc """
  W3 contract (PLAN-012): the render-domain hole host.

  `resolve_holes/2` thaws + evaluates `tmpl::` deferred holes against a live
  `data/*` env, every frame. Pins: value substitution, splice flattening, the
  capability boundary (no effects), the per-hole failure ladder (never raises),
  and the end-to-end loop from a `tmpl::`-frozen tree.
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp
  alias SpellAgent.Tui.HoleResolver

  # Build a frozen layout tree from tmpl:: source (the real W2 producer).
  defp frozen(src) do
    {:ok, step} = Lisp.run(src)
    step.return
  end

  defp resolve(src, env), do: HoleResolver.resolve_holes(frozen(src), env)

  # ============================================================
  # value substitution
  # ============================================================

  describe "value holes resolve against data/*" do
    test "a hole reads a nested data value" do
      tree =
        resolve(~S|(tmpl:: {:text ~(get data/status :model)})|, %{
          "status" => %{"model" => "opus"}
        })

      assert tree[:text] == "opus" or tree["text"] == "opus"
    end

    test "a hole computes from data" do
      tree = resolve(~S|(tmpl:: {:n ~(* 2 (get data/x :v))})|, %{"x" => %{"v" => 21}})
      assert (tree[:n] || tree["n"]) == 42
    end

    test "static content passes through untouched" do
      tree = resolve(~S|(tmpl:: {:type "paragraph" :text "static"})|, %{})
      assert (tree[:type] || tree["type"]) == "paragraph"
      assert (tree[:text] || tree["text"]) == "static"
    end

    test "a style hole flips on run state" do
      on =
        resolve(~S|(tmpl:: {:fg ~(if (get data/s :running?) "yellow" "green")})|, %{
          "s" => %{"running?" => true}
        })

      off =
        resolve(~S|(tmpl:: {:fg ~(if (get data/s :running?) "yellow" "green")})|, %{
          "s" => %{"running?" => false}
        })

      assert (on[:fg] || on["fg"]) == "yellow"
      assert (off[:fg] || off["fg"]) == "green"
    end
  end

  # ============================================================
  # splice flattening
  # ============================================================

  describe "splice holes flatten into the parent sequence" do
    test "~@list splices its elements" do
      tree = resolve(~S|(tmpl:: {:items [~@data/xs]})|, %{"xs" => [1, 2, 3]})
      assert (tree["items"] || tree[:items]) == [1, 2, 3]
    end

    test "a splice composes with surrounding elements" do
      tree = resolve(~S|(tmpl:: {:items [0 ~@data/xs 9]})|, %{"xs" => [1, 2]})
      assert (tree["items"] || tree[:items]) == [0, 1, 2, 9]
    end

    test "a splice over a mapped expression" do
      tree =
        resolve(~S|(tmpl:: {:items [~@(map (fn [x] (* x 10)) data/xs)]})|, %{"xs" => [1, 2, 3]})

      assert (tree["items"] || tree[:items]) == [10, 20, 30]
    end

    test "an empty splice contributes nothing" do
      tree = resolve(~S|(tmpl:: {:items [1 ~@data/xs]})|, %{"xs" => []})
      assert (tree["items"] || tree[:items]) == [1]
    end
  end

  # ============================================================
  # capability boundary — looking never acts
  # ============================================================

  describe "capability boundary" do
    test "a hole calling tool/ is blocked, yields the placeholder (no effect)" do
      tree = resolve(~S|(tmpl:: {:bad ~(tool/sh {:argv ["echo" "hi"]})})|, %{})
      assert (tree[:bad] || tree["bad"]) == HoleResolver.placeholder()
    end

    test "a hole calling layout/set is blocked" do
      tree = resolve(~S|(tmpl:: {:bad ~(layout/set {:slot "x" :node {}})})|, %{})
      assert (tree[:bad] || tree["bad"]) == HoleResolver.placeholder()
    end
  end

  # ============================================================
  # failure ladder — never raises
  # ============================================================

  describe "failure ladder" do
    test "a raising hole becomes the placeholder; siblings still resolve" do
      tree = resolve(~S|(tmpl:: {:boom ~(/ 1 0) :ok ~(+ 1 1)})|, %{})
      assert (tree[:boom] || tree["boom"]) == HoleResolver.placeholder()
      assert (tree[:ok] || tree["ok"]) == 2
    end

    test "a hole referencing a missing data key degrades, does not raise" do
      tree = resolve(~S|(tmpl:: {:x ~(get data/missing :k)})|, %{})
      # missing data → nil get → nil value (a clean resolution, not a crash)
      assert Map.has_key?(tree, :x) or Map.has_key?(tree, "x")
    end

    test "resolve_holes never raises on arbitrary nested junk" do
      junk = %{
        "a" => %{"__hole__" => %{"node" => "bogus"}},
        "b" => [%{"__splice__" => %{"node" => "nope"}}]
      }

      assert %{} = HoleResolver.resolve_holes(junk, %{})
    end
  end

  # ============================================================
  # nesting + structure
  # ============================================================

  describe "nested structure" do
    test "holes resolve at any depth" do
      tree = resolve(~S|(tmpl:: {:a {:b {:c ~(get data/d :v)}}})|, %{"d" => %{"v" => 7}})
      c = (tree[:a] || tree["a"])[:b] || (tree[:a] || tree["a"])["b"]
      assert (c[:c] || c["c"]) == 7
    end

    test "a splice that builds rows from data resolves to per-row maps" do
      # The splice expr maps data into row maps; each row is built at resolve time
      # from the live data — the keyed-list-comprehension shape (W6 will diff it).
      tree =
        resolve(
          ~S|(tmpl:: {:rows [~@(map (fn [n] {:label n}) data/ns)]})|,
          %{"ns" => [1, 2]}
        )

      rows = tree["rows"] || tree[:rows]
      assert length(rows) == 2
      assert Enum.all?(rows, &is_map/1)
    end
  end

  # ============================================================
  # idempotence / non-hole trees
  # ============================================================

  describe "trees without holes" do
    test "a plain tree is returned unchanged" do
      tree = %{"type" => "split", "children" => [%{"type" => "paragraph", "text" => "x"}]}
      assert HoleResolver.resolve_holes(tree, %{}) == tree
    end
  end
end
