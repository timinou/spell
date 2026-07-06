defmodule SpellAgent.Tui.ForestDiffTest do
  @moduledoc """
  FEAT-038: the change-RADIUS primitive for incremental reproject. The span
  forest is a flat %{id => Span} map with parent_id links, so a change's radius
  is the changed ids + their root paths (parent-chain walk).
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.ForestDiff
  alias SpellAgent.Tui.Store.Span

  defp span(id, parent_id, kind \\ :turn) do
    %Span{id: id, parent_id: parent_id, kind: kind}
  end

  defp forest(spans), do: Map.new(spans, &{&1.id, &1})

  describe "changed_ids/2" do
    test "an added span is changed" do
      prev = forest([span("a", nil)])
      curr = forest([span("a", nil), span("b", "a")])
      assert ForestDiff.changed_ids(prev, curr) == MapSet.new(["b"])
    end

    test "a removed span is changed" do
      prev = forest([span("a", nil), span("b", "a")])
      curr = forest([span("a", nil)])
      assert ForestDiff.changed_ids(prev, curr) == MapSet.new(["b"])
    end

    test "a mutated span is changed, an identical one is not" do
      prev = forest([span("a", nil, :turn), span("b", "a", :turn)])
      curr = forest([span("a", nil, :turn), span("b", "a", :run)])
      assert ForestDiff.changed_ids(prev, curr) == MapSet.new(["b"])
    end

    test "identical forests have no changes" do
      f = forest([span("a", nil), span("b", "a")])
      assert ForestDiff.changed_ids(f, f) == MapSet.new()
    end
  end

  describe "path_of/2 (radius = the root path)" do
    test "a root span's path is just itself" do
      f = forest([span("a", nil)])
      assert ForestDiff.path_of(f, "a") == ["a"]
    end

    test "a nested span's path is root-first" do
      f = forest([span("a", nil), span("b", "a"), span("c", "b")])
      assert ForestDiff.path_of(f, "c") == ["a", "b", "c"]
    end

    test "an id not in the forest has an empty path" do
      f = forest([span("a", nil)])
      assert ForestDiff.path_of(f, "missing") == []
    end

    test "a cycle is bounded (never loops forever)" do
      # A malformed forest where a points to b and b points to a.
      f = forest([span("a", "b"), span("b", "a")])
      path = ForestDiff.path_of(f, "a")
      # Terminates and returns a finite path (exact contents don't matter — the
      # point is no infinite loop).
      assert is_list(path)
      assert length(path) <= 2
    end
  end

  describe "dirty_paths/2" do
    test "yields one root-path per changed span" do
      prev = forest([span("a", nil), span("b", "a")])
      curr = forest([span("a", nil), span("b", "a"), span("c", "b")])
      # Only c changed (added); its path is a->b->c.
      assert ForestDiff.dirty_paths(prev, curr) == [["a", "b", "c"]]
    end

    test "an unchanged forest yields no paths" do
      f = forest([span("a", nil)])
      assert ForestDiff.dirty_paths(f, f) == []
    end

    test "a DELETED span still yields a path (resolved in prev) so a pane can evict it" do
      # review S3 P2: a deletion-only batch must not produce zero paths, else an
      # incremental pane can never learn to drop the deleted subtree.
      prev = forest([span("a", nil), span("b", "a"), span("c", "b")])
      curr = forest([span("a", nil), span("b", "a")])
      # c was deleted; its path is resolved against prev -> a->b->c.
      assert ForestDiff.dirty_paths(prev, curr) == [["a", "b", "c"]]
    end
  end
end
