defmodule SpellAgent.Tui.ForestDiff do
  @moduledoc """
  Compute the RADIUS of a change between two span forests (PLAN-025 W3,
  FEAT-038).

  The span forest is a flat `%{id => Span.t()}` map whose nodes carry a
  `parent_id` (NOT a rose tree — the vestigial `ex_rose_tree` dep was removed).
  So a change's radius is a cheap, addressable thing: the set of changed span
  ids, plus each one's ROOT PATH (its parent chain), computed by walking
  `parent_id` in O(depth).

  This is the reusable primitive the incremental reproject builds on. It mirrors
  the reactive-Cell dep model (`HoleDiff.changed_keys/2` diffs a bag; here we
  diff a forest) rather than inventing a parallel mechanism: same shape — old vs
  new, emit the changed set — one level up (spans, not hole keys).

  A pane that opts into incremental projection (`project_incremental/3`) receives
  these `dirty_paths` and may recompute only the affected subtrees; a pane
  without it falls back to the full `project/2`. So the affordance is additive:
  nothing regresses, incremental panes just do less work.
  """

  @type forest :: %{optional(String.t()) => struct()}
  @type path :: [String.t()]

  @doc """
  The set of span ids that changed between `prev` and `curr` — added, removed, or
  whose struct value differs. Mirrors `HoleDiff.changed_keys/2`.
  """
  @spec changed_ids(forest(), forest()) :: MapSet.t(String.t())
  def changed_ids(prev, curr) when is_map(prev) and is_map(curr) do
    ids = MapSet.union(MapSet.new(Map.keys(prev)), MapSet.new(Map.keys(curr)))
    for id <- ids, Map.get(prev, id) != Map.get(curr, id), into: MapSet.new(), do: id
  end

  @doc """
  The ROOT PATH of a span id in `forest`: `[root_id, …, id]`, walking `parent_id`
  up from `id`. Returns `[id]` for a root, `[]` for an id not in the forest.
  O(depth). A cycle (should never happen in a well-formed forest) is bounded by a
  visited-set so this can never loop forever.
  """
  @spec path_of(forest(), String.t()) :: path()
  def path_of(forest, id) when is_map(forest) and is_binary(id) do
    # walk_up accumulates by prepending each id as it climbs from leaf to root,
    # so the accumulator ends up ROOT-FIRST already ([root, …, leaf]).
    walk_up(id, forest, MapSet.new(), [])
  end

  @doc """
  The `dirty_paths` for a forest change: one root-path per changed span id. This
  is the radius hint threaded to an incremental pane projection.
  """
  @spec dirty_paths(forest(), forest()) :: [path()]
  def dirty_paths(prev, curr) do
    prev
    |> changed_ids(curr)
    |> Enum.map(fn id ->
      # Resolve the id in whichever forest still holds it: a MUTATED/ADDED span
      # lives in `curr`; a DELETED span is gone from `curr` but still in `prev`
      # (review S3 P2 — without the prev fallback a deletion-only batch produced
      # NO paths, so an incremental pane could never evict the deleted subtree).
      case path_of(curr, id) do
        [] -> path_of(prev, id)
        p -> p
      end
    end)
    |> Enum.reject(&(&1 == []))
  end

  # Walk parent_id up to the root, accumulating ids (leaf-first), guarding cycles.
  defp walk_up(nil, _forest, _seen, acc), do: acc

  defp walk_up(id, forest, seen, acc) do
    cond do
      MapSet.member?(seen, id) ->
        acc

      true ->
        case Map.get(forest, id) do
          nil -> acc
          %{parent_id: parent} -> walk_up(parent, forest, MapSet.put(seen, id), [id | acc])
          _ -> [id | acc]
        end
    end
  end
end
