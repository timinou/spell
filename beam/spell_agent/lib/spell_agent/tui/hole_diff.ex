defmodule SpellAgent.Tui.HoleDiff do
  @moduledoc """
  Per-hole dirty-tracking (PLAN-012 W6) — the atomic-diff substrate, LiveView's
  statics/dynamics split derived STRUCTURALLY (no compile pass).

  ## The idea

  `tmpl::` already separated a layout into a STATIC skeleton (inert data) and
  DYNAMIC holes (`{"__hole__" => codec}` leaves). W6 adds the third LiveView
  ingredient — change tracking — so that, per frame, ONLY the holes whose `data/*`
  dependencies actually changed are re-evaluated; the rest reuse their cached
  value.

  ```
  LiveView                          HoleDiff
  ─────────────────────────────     ─────────────────────────────
  statics (sent once)               the frozen skeleton (tree minus holes)
  dynamics (re-sent on change)      the holes, keyed by tree PATH
  __changed__ (assigns)             which data/* keys changed this frame
  per-dynamic change tracking       reuse keyed on {path, frozen} identity + deps
  ```

  ## What this module computes

    * `dependencies/1` — the set of `data/<key>` names a frozen hole form reads
      (static analysis of the codec data: every `%{"node"=>"sym","value"=>"data/k"}`
      contributes `"k"`). Computed once per hole.
    * `changed_keys/2` — the `data/*` keys whose value differs between the previous
      and current bag (shallow `!=`).
    * `resolve/4` — the cached resolve: re-evaluate only holes whose deps intersect
      the changed set; reuse `prev`'s value for the rest. The result is a `%Cache{}`
      carrying the resolved tree + the per-path values + the env, to thread into the
      next frame.

  ## The correctness invariant (the W6 gate)

  `resolve/4` MUST produce a tree EQUAL to `HoleResolver.resolve_holes/2` for any
  sequence of bag deltas — the cache is an OPTIMIZATION, never a semantic change.
  A property test pins this. So the App can always fall back to the uncached path.
  """

  alias SpellAgent.Tui.HoleResolver

  @hole_key "__hole__"
  @splice_key "__splice__"

  defmodule Cache do
    @moduledoc "Threaded render-to-render hole-diff state."
    @enforce_keys [:tree, :env]
    defstruct tree: nil, env: %{}, values: %{}, table: nil

    @type t :: %__MODULE__{
            tree: term(),
            env: map(),
            values: %{optional([term()]) => term()},
            table: [{[term()], map(), MapSet.t()}] | nil
          }
  end

  # ============================================================
  # dependency analysis
  # ============================================================

  @doc """
  The set of `data/<key>` names a frozen hole form (codec data) reads.

  Walks the codec encoding for `%{"node" => "sym", "value" => "data/<k>"}` leaves
  and collects `"<k>"` (the top-level bag key — `data/status` -> `"status"`).
  """
  @spec dependencies(term()) :: MapSet.t()
  def dependencies(frozen), do: collect_deps(frozen, MapSet.new())

  defp collect_deps(%{"node" => "sym", "value" => "data/" <> rest}, acc),
    do: MapSet.put(acc, top_key(rest))

  defp collect_deps(map, acc) when is_map(map) and not is_struct(map),
    do: Enum.reduce(map, acc, fn {_k, v}, a -> collect_deps(v, a) end)

  defp collect_deps(list, acc) when is_list(list),
    do: Enum.reduce(list, acc, fn elem, a -> collect_deps(elem, a) end)

  defp collect_deps(_other, acc), do: acc

  # `data/status` -> "status"; `data/status-cost` stays "status-cost" (the bag key).
  # Only a `/` would split further, but bag keys never contain `/`, so the whole
  # remainder IS the key.
  defp top_key(rest), do: rest

  # ============================================================
  # changed-key detection
  # ============================================================

  @doc "The set of `data/*` keys whose value differs between `prev` and `curr`."
  @spec changed_keys(map(), map()) :: MapSet.t()
  def changed_keys(prev, curr) when is_map(prev) and is_map(curr) do
    keys = MapSet.union(MapSet.new(Map.keys(prev)), MapSet.new(Map.keys(curr)))
    for k <- keys, Map.get(prev, k) != Map.get(curr, k), into: MapSet.new(), do: k
  end

  # ============================================================
  # cached resolve
  # ============================================================

  @doc """
  Resolve `tree`'s holes against `env`, reusing `prev` (a `%Cache{}` from the last
  frame) for any hole whose dependencies did not change. Returns a fresh `%Cache{}`.

  Reuse is decided PER-HOLE: a hole reuses the prior value iff the prior frame had
  a hole at the SAME path with the IDENTICAL frozen form AND none of its deps
  changed. So a reshaped skeleton, a changed hole expression, or a changed input
  all force that hole to re-evaluate — there is no whole-tree fingerprint to
  collide. When `prev` is nil every hole evaluates from scratch.
  """
  @spec resolve(term(), map(), Cache.t() | nil, keyword()) :: Cache.t()
  def resolve(tree, env, prev \\ nil, _opts \\ []) do
    # ALWAYS build the table from the CURRENT tree (cheap structural walk) — never
    # trust a fingerprint to imply the holes are unchanged. Reuse is decided
    # PER-HOLE on the prior frame's `{path, frozen}` identity, so a changed hole
    # FORM (same path, different expression) never reuses a stale value, and a
    # whole-tree hash collision is impossible (there is no whole-tree hash). (W6
    # review #1 + #2.)
    table = build_table(tree)
    changed = if prev, do: changed_keys(prev.env, env), else: nil

    values =
      Map.new(table, fn {path, frozen, deps} ->
        {path, value_for(path, frozen, deps, env, changed, prev)}
      end)

    %Cache{
      tree: rebuild(tree, values),
      env: env,
      values: values,
      table: table
    }
  end

  @doc """
  The resolved tree from a `%Cache{}` (what the render walk consumes).
  """
  @spec tree(Cache.t()) :: term()
  def tree(%Cache{tree: tree}), do: tree

  # The value for one hole: REUSE the prior frame's value iff (a) there is a prior
  # frame, (b) the prior frame had a hole at this SAME path with the IDENTICAL
  # frozen form, and (c) none of this hole's deps changed. Otherwise re-evaluate.
  # Conditions (b)+(c) together guarantee cached == uncached: a reused value is one
  # the uncached resolver would produce for the same form against unchanged inputs.
  defp value_for(path, frozen, deps, env, changed, prev) do
    if prev && reuse?(path, frozen, deps, changed, prev) do
      Map.get(prev.values, path)
    else
      eval_at(frozen, env)
    end
  end

  defp reuse?(path, frozen, deps, changed, %Cache{} = prev) do
    MapSet.size(MapSet.intersection(deps, changed)) == 0 and
      prev_frozen(prev, path) == frozen and
      Map.has_key?(prev.values, path)
  end

  # The frozen form the prior frame had at `path` (nil if none) — the identity check
  # that defeats same-shape/changed-form staleness.
  defp prev_frozen(%Cache{table: table}, path) when is_list(table) do
    Enum.find_value(table, fn {p, f, _d} -> if p == path, do: f end)
  end

  defp prev_frozen(_prev, _path), do: nil

  # ---- per-hole eval (reuses the W3 host, single hole) ----

  # Evaluate one hole NODE (the whole `%{"__hole__"|"__splice__" => …}` map) via
  # the SAME capability-bounded host the uncached resolver uses, so cached and
  # uncached agree exactly — INCLUDING failure semantics (a value hole that raises
  # -> placeholder; a splice that yields a non-list -> placeholder). Passing the
  # real node (not a re-wrapped form) preserves the hole KIND.
  defp eval_at(node, env) do
    HoleResolver.resolve_holes(node, env)
  end

  # ---- rebuild the tree from cached per-path values ----
  #
  # Walk the tree; at each hole path substitute the cached value (value holes) or
  # flatten the cached list (splice holes). Mirrors HoleResolver's walk shape so
  # the structural result is identical, but pulls VALUES from the cache instead of
  # re-evaluating.

  # The cached `values[path]` is ALREADY the host's resolved output for that hole
  # (a value, or a splice's list / placeholder — `eval_at` ran the real node, so
  # failure semantics already match the uncached resolver). So rebuild just
  # substitutes the cached value at each hole path; a splice in a SEQ flattens its
  # cached list, mirroring HoleResolver exactly.
  defp rebuild(tree, values), do: do_rebuild(tree, [], values)

  defp do_rebuild(%{@hole_key => _}, path, values),
    do: fetch_or_placeholder(values, path)

  defp do_rebuild(%{@splice_key => _}, path, values),
    do: fetch_or_placeholder(values, path)

  defp do_rebuild(map, path, values) when is_map(map) and not is_struct(map) do
    Map.new(map, fn {k, v} -> {k, do_rebuild(v, path ++ [k], values)} end)
  end

  defp do_rebuild(list, path, values) when is_list(list) do
    list
    |> Enum.with_index()
    |> Enum.flat_map(fn {elem, i} -> rebuild_seq_elem(elem, path ++ [i], values) end)
  end

  defp do_rebuild(other, _path, _values), do: other

  # A `__splice__` in a list flattens its cached list into the parent; a non-list
  # cached value (the host already turned a bad splice into the placeholder) is
  # wrapped as a single element, matching HoleResolver.walk_seq_elem.
  defp rebuild_seq_elem(%{@splice_key => _}, path, values) do
    case fetch_or_placeholder(values, path) do
      list when is_list(list) -> list
      other -> [other]
    end
  end

  defp rebuild_seq_elem(elem, path, values), do: [do_rebuild(elem, path, values)]

  defp fetch_or_placeholder(values, path),
    do: Map.get(values, path, HoleResolver.placeholder())

  # ============================================================
  # hole table (path -> {frozen, deps}) + skeleton stripping
  # ============================================================

  @doc """
  Build the flat hole table for `tree`: a list of `{path, frozen, deps}`, one per
  hole, where `path` is the tree address (map keys / list indices) and `deps` is
  the hole's `data/*` dependency set.
  """
  @spec build_table(term()) :: [{[term()], map(), MapSet.t()}]
  def build_table(tree), do: tree |> table_walk([], []) |> Enum.reverse()

  defp table_walk(%{@hole_key => frozen} = node, path, acc),
    do: [{path, node, dependencies(frozen)} | acc]

  defp table_walk(%{@splice_key => frozen} = node, path, acc),
    do: [{path, node, dependencies(frozen)} | acc]

  defp table_walk(map, path, acc) when is_map(map) and not is_struct(map),
    do: Enum.reduce(map, acc, fn {k, v}, a -> table_walk(v, path ++ [k], a) end)

  defp table_walk(list, path, acc) when is_list(list) do
    list
    |> Enum.with_index()
    |> Enum.reduce(acc, fn {elem, i}, a -> table_walk(elem, path ++ [i], a) end)
  end

  defp table_walk(_other, _path, acc), do: acc
end
