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
  fingerprint                       structural hash of the skeleton
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
    defstruct tree: nil, env: %{}, values: %{}, table: nil, fingerprint: nil

    @type t :: %__MODULE__{
            tree: term(),
            env: map(),
            values: %{optional([term()]) => term()},
            table: [{[term()], map(), MapSet.t()}] | nil,
            fingerprint: term()
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

  When `prev` is nil, or the tree's fingerprint changed (the skeleton was reshaped),
  every hole is re-evaluated from scratch.
  """
  @spec resolve(term(), map(), Cache.t() | nil, keyword()) :: Cache.t()
  def resolve(tree, env, prev \\ nil, _opts \\ []) do
    fingerprint = :erlang.phash2(strip_holes(tree))

    if reusable?(prev, fingerprint) do
      incremental(tree, env, prev, fingerprint)
    else
      full(tree, env, fingerprint)
    end
  end

  @doc """
  The resolved tree from a `%Cache{}` (what the render walk consumes).
  """
  @spec tree(Cache.t()) :: term()
  def tree(%Cache{tree: tree}), do: tree

  # ---- full (cold) resolve ----

  defp full(tree, env, fingerprint) do
    table = build_table(tree)

    values =
      Map.new(table, fn {path, frozen, _deps} ->
        {path, eval_at(frozen, env)}
      end)

    %Cache{
      tree: HoleResolver.resolve_holes(tree, env),
      env: env,
      values: values,
      table: table,
      fingerprint: fingerprint
    }
  end

  # ---- incremental (warm) resolve ----

  defp incremental(tree, env, %Cache{} = prev, fingerprint) do
    changed = changed_keys(prev.env, env)

    values =
      Map.new(prev.table, fn {path, frozen, deps} ->
        if MapSet.size(MapSet.intersection(deps, changed)) > 0 do
          {path, eval_at(frozen, env)}
        else
          {path, Map.get(prev.values, path)}
        end
      end)

    # Splice holes change the tree SHAPE, so a tree rebuild is still needed; but a
    # value hole reuses its cached value via `env` overlay is not enough — we
    # rebuild from the per-path values to honour reuse exactly. The reuse win is
    # in SKIPPING the eval (the expensive part), proven by the eval-count tests;
    # the rebuild walk is cheap structure-copying.
    %Cache{
      tree: rebuild(tree, env, values),
      env: env,
      values: values,
      table: prev.table,
      fingerprint: fingerprint
    }
  end

  defp reusable?(nil, _fp), do: false
  defp reusable?(%Cache{fingerprint: fp}, fp), do: true
  defp reusable?(%Cache{}, _fp), do: false

  # ---- per-hole eval (reuses the W3 host, single hole) ----

  # Evaluate one frozen hole to {:ok, value} | :error via the SAME capability-
  # bounded host the uncached resolver uses, so cached and uncached agree exactly.
  defp eval_at(frozen, env) do
    HoleResolver.resolve_holes(%{@hole_key => frozen}, env)
  end

  # ---- rebuild the tree from cached per-path values ----
  #
  # Walk the tree; at each hole path substitute the cached value (value holes) or
  # flatten the cached list (splice holes). Mirrors HoleResolver's walk shape so
  # the structural result is identical, but pulls VALUES from the cache instead of
  # re-evaluating.

  defp rebuild(tree, env, values), do: do_rebuild(tree, [], env, values)

  defp do_rebuild(%{@hole_key => _frozen}, path, _env, values),
    do: fetch_or_placeholder(values, path)

  defp do_rebuild(%{@splice_key => _frozen}, path, _env, values) do
    case fetch_or_placeholder(values, path) do
      list when is_list(list) -> list
      other -> other
    end
  end

  defp do_rebuild(map, path, env, values) when is_map(map) and not is_struct(map) do
    Map.new(map, fn {k, v} -> {k, do_rebuild(v, path ++ [k], env, values)} end)
  end

  defp do_rebuild(list, path, env, values) when is_list(list) do
    list
    |> Enum.with_index()
    |> Enum.flat_map(fn {elem, i} -> rebuild_seq_elem(elem, path ++ [i], env, values) end)
  end

  defp do_rebuild(other, _path, _env, _values), do: other

  defp rebuild_seq_elem(%{@splice_key => _frozen}, path, _env, values) do
    case fetch_or_placeholder(values, path) do
      list when is_list(list) -> list
      _ -> [HoleResolver.placeholder()]
    end
  end

  defp rebuild_seq_elem(elem, path, env, values), do: [do_rebuild(elem, path, env, values)]

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

  defp table_walk(%{@hole_key => frozen}, path, acc),
    do: [{path, frozen, dependencies(frozen)} | acc]

  defp table_walk(%{@splice_key => frozen}, path, acc),
    do: [{path, frozen, dependencies(frozen)} | acc]

  defp table_walk(map, path, acc) when is_map(map) and not is_struct(map),
    do: Enum.reduce(map, acc, fn {k, v}, a -> table_walk(v, path ++ [k], a) end)

  defp table_walk(list, path, acc) when is_list(list) do
    list
    |> Enum.with_index()
    |> Enum.reduce(acc, fn {elem, i}, a -> table_walk(elem, path ++ [i], a) end)
  end

  defp table_walk(_other, _path, acc), do: acc

  # The skeleton fingerprint: the tree with every hole replaced by a constant
  # marker, so two trees that differ ONLY in hole FORMS still share a fingerprint
  # iff their structure matches. (Used to decide cache reuse.)
  defp strip_holes(%{@hole_key => _}), do: :__hole__
  defp strip_holes(%{@splice_key => _}), do: :__splice__

  defp strip_holes(map) when is_map(map) and not is_struct(map),
    do: Map.new(map, fn {k, v} -> {k, strip_holes(v)} end)

  defp strip_holes(list) when is_list(list), do: Enum.map(list, &strip_holes/1)
  defp strip_holes(other), do: other
end
