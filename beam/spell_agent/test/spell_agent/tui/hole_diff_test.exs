defmodule SpellAgent.Tui.HoleDiffTest do
  @moduledoc """
  W6 contract (PLAN-012): per-hole dirty-tracking — the atomic-diff substrate.

  The load-bearing guarantee (the W6 gate): the cached resolve is EQUAL to the
  uncached `HoleResolver.resolve_holes/2` for ANY sequence of bag deltas. The
  cache is an optimization, never a semantic change. Plus: dependency analysis is
  precise, and a hole whose deps did not change is NOT re-evaluated (the skip that
  makes it LiveView-style atomic).
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias SpellAgent.Tui.{HoleDiff, HoleResolver}
  alias PtcRunner.Lisp

  defp frozen(src) do
    {:ok, step} = Lisp.run(src)
    step.return
  end

  # ============================================================
  # dependency analysis
  # ============================================================

  describe "dependencies/1" do
    test "extracts the data/* keys a hole reads" do
      tree = frozen(~S|(tmpl:: {:x ~(get data/status :model)})|)
      [{_path, hole_frozen, _deps}] = HoleDiff.build_table(tree)
      assert HoleDiff.dependencies(hole_frozen) == MapSet.new(["status"])
    end

    test "a fine-grained scalar key is captured whole" do
      tree = frozen(~S|(tmpl:: {:x ~(+ data/forest-count 1)})|)
      [{_p, f, _d}] = HoleDiff.build_table(tree)
      assert HoleDiff.dependencies(f) == MapSet.new(["forest-count"])
    end

    test "a hole with no data dep has empty deps" do
      tree = frozen(~S|(tmpl:: {:x ~(+ 1 2)})|)
      [{_p, f, _d}] = HoleDiff.build_table(tree)
      assert HoleDiff.dependencies(f) == MapSet.new()
    end

    test "multiple deps in one hole are all captured" do
      tree = frozen(~S|(tmpl:: {:x ~(+ data/a data/b)})|)
      [{_p, f, _d}] = HoleDiff.build_table(tree)
      assert HoleDiff.dependencies(f) == MapSet.new(["a", "b"])
    end
  end

  describe "build_table/1" do
    test "lists each hole with its tree path and deps" do
      tree = frozen(~S|(tmpl:: {:a ~(get data/s :m) :b ~(+ 1 2)})|)
      table = HoleDiff.build_table(tree) |> Enum.map(fn {p, _f, d} -> {p, MapSet.to_list(d)} end)
      assert {["a"], ["s"]} in table
      assert {["b"], []} in table
    end

    test "captures a hole nested in a list path" do
      tree = frozen(~S|(tmpl:: {:items [0 ~(get data/x :v) 2]})|)
      paths = HoleDiff.build_table(tree) |> Enum.map(fn {p, _, _} -> p end)
      assert ["items", 1] in paths
    end
  end

  describe "changed_keys/2" do
    test "detects added/removed/changed keys" do
      assert HoleDiff.changed_keys(%{"a" => 1, "b" => 2}, %{"a" => 1, "b" => 9}) ==
               MapSet.new(["b"])

      assert HoleDiff.changed_keys(%{"a" => 1}, %{"a" => 1, "c" => 3}) == MapSet.new(["c"])
      assert HoleDiff.changed_keys(%{"a" => 1}, %{"a" => 1}) == MapSet.new()
    end
  end

  # ============================================================
  # the W6 gate — cached ≡ uncached
  # ============================================================

  describe "cached resolve equals uncached (the invariant)" do
    test "a full (cold) resolve equals resolve_holes" do
      tree = frozen(~S|(tmpl:: {:a ~(get data/s :m) :b ~(+ data/n 1) :c "static"})|)
      env = %{"s" => %{"m" => "x"}, "n" => 5}
      cache = HoleDiff.resolve(tree, env)
      assert HoleDiff.tree(cache) == HoleResolver.resolve_holes(tree, env)
    end

    test "an incremental resolve equals resolve_holes after a delta" do
      tree = frozen(~S|(tmpl:: {:a ~(get data/s :m) :b ~(+ data/n 1)})|)
      e1 = %{"s" => %{"m" => "x"}, "n" => 5}
      e2 = %{"s" => %{"m" => "y"}, "n" => 5}
      c1 = HoleDiff.resolve(tree, e1)
      c2 = HoleDiff.resolve(tree, e2, c1)
      assert HoleDiff.tree(c2) == HoleResolver.resolve_holes(tree, e2)
    end

    test "a splice hole stays correct across an incremental resolve" do
      tree = frozen(~S|(tmpl:: {:items [~@data/xs]})|)
      c1 = HoleDiff.resolve(tree, %{"xs" => [1, 2]})
      c2 = HoleDiff.resolve(tree, %{"xs" => [1, 2, 3]}, c1)
      assert HoleDiff.tree(c2) == HoleResolver.resolve_holes(tree, %{"xs" => [1, 2, 3]})
    end
  end

  # ============================================================
  # the skip — a clean hole is NOT re-evaluated
  # ============================================================

  describe "dirty-skip (atomic invalidation)" do
    test "a hole whose deps did not change reuses its prior value" do
      tree = frozen(~S|(tmpl:: {:a ~(get data/s :m) :b ~(+ data/n 1)})|)
      c1 = HoleDiff.resolve(tree, %{"s" => %{"m" => "keep"}, "n" => 1})

      # change ONLY n; `a` (deps={s}) must reuse, `b` (deps={n}) must recompute.
      c2 = HoleDiff.resolve(tree, %{"s" => %{"m" => "keep"}, "n" => 2}, c1)
      out = HoleDiff.tree(c2)
      assert out["a"] == "keep"
      assert out["b"] == 3
    end

    test "with NO change, every value is reused (no recompute path observable)" do
      tree = frozen(~S|(tmpl:: {:a ~(get data/s :m)})|)
      env = %{"s" => %{"m" => "x"}}
      c1 = HoleDiff.resolve(tree, env)
      c2 = HoleDiff.resolve(tree, env, c1)
      assert HoleDiff.tree(c2) == HoleDiff.tree(c1)
    end

    test "a fingerprint change (reshaped skeleton) forces a full re-resolve" do
      t1 = frozen(~S|(tmpl:: {:a ~(get data/s :m)})|)
      t2 = frozen(~S|(tmpl:: {:a ~(get data/s :m) :b ~(get data/s :n)})|)
      c1 = HoleDiff.resolve(t1, %{"s" => %{"m" => "x", "n" => "y"}})
      # different tree -> fingerprint differs -> full resolve, still correct.
      c2 = HoleDiff.resolve(t2, %{"s" => %{"m" => "x", "n" => "y"}}, c1)

      assert HoleDiff.tree(c2) ==
               HoleResolver.resolve_holes(t2, %{"s" => %{"m" => "x", "n" => "y"}})
    end
  end

  # ============================================================
  # property — cached ≡ uncached over random delta sequences
  # ============================================================

  property "cached resolve == uncached resolve across any sequence of bag deltas" do
    tree = frozen(~S|(tmpl:: {:a ~(get data/s :m) :b ~(+ data/n 1) :c ~data/flag :d "static"})|)

    gen_env =
      StreamData.fixed_map(%{
        "s" => StreamData.map(StreamData.string(?a..?z, max_length: 3), &%{"m" => &1}),
        "n" => StreamData.integer(0..100),
        "flag" => StreamData.boolean()
      })

    check all(envs <- StreamData.list_of(gen_env, min_length: 1, max_length: 8)) do
      # Thread the cache through the whole sequence; at EVERY step the cached tree
      # must equal the uncached resolve for that step's env.
      Enum.reduce(envs, nil, fn env, prev_cache ->
        cache = HoleDiff.resolve(tree, env, prev_cache)
        assert HoleDiff.tree(cache) == HoleResolver.resolve_holes(tree, env)
        cache
      end)
    end
  end
end
