defmodule SpellAgent.Tui.Tree do
  @moduledoc """
  The canonical layout-node abstraction (PLAN-021 W1) — ONE rose-tree type and
  ONE generic traversal, so the layout tree's mechanics live in a single place
  instead of being re-discovered at every call site.

  ## The problem this dissolves

  Before W1 the layout was "plain string-keyed maps" with no Node abstraction.
  Every module that touched the tree re-implemented the same three things:

    * shape dispatch — `is_map(x) and not is_struct(x)` / `is_list(x)` / leaf,
    * key access — `Map.get(m, key) || Map.get(m, safe_atom(key))` (string OR
      atom keys), each with its own private `safe_atom/1`,
    * the recursion over `"children"`.

  The result was ~9 hand-rolled recursions and 7 verbatim `safe_atom/1` copies.
  A structural invariant (how a node is shaped, how a key is read, how children
  are walked) that is re-checked everywhere is an invariant guaranteed NOWHERE.

  ## What a node is

  A layout node is a string-or-atom-keyed map. Two shapes:

    * a SPLIT / pane container — carries `"children"` (a list of child nodes),
      plus `"type"`, `"slot"`, `"tags"`, `"dir"`, `"constraints"`, …
    * a LEAF — any node without children: a reflected `view/*` widget map, a
      native `"pane"` node, or a frozen `tmpl::` hole.

  Widgets become structs only at materialize time; in the TREE everything is a
  plain map, so the rose-tree walk treats a struct as an OPAQUE LEAF (never
  recurses into it — a `%Style{}` is not a child).

  ## The two traversal families (do not conflate)

  This module is the ROSE-TREE family: structure over the `"children"` edge —
  focus rings, slot addressing, pane mapping, subtree replacement. The OTHER
  family (`HoleDiff` / `HoleResolver`) is a generic DATA walk over every map
  value and list index (a hole can hide inside `:style`/`:block`), governed by a
  cached==uncached property gate. That one is deliberately NOT routed through
  here: its edge set is "all values", not "children".

  ## Accessor convention (the one `safe_atom`)

  `get/2` reads a key as the string first, then the existing-atom form — the
  string/atom duality the agent's PTC maps carry. `safe_atom/1` uses
  `String.to_existing_atom/1` (never interns — the atom-DoS posture inherited
  from `Ui.safe_*`). This is the SINGLE definition the rest of the TUI delegates
  to.
  """

  @typedoc "A layout tree node: a string- or atom-keyed map."
  @type node_map :: %{optional(String.t() | atom()) => term()}

  @typedoc "A predicate over nodes."
  @type pred :: (node_map() -> boolean())

  # ================================================================
  # node accessors — the canonical string-or-atom key surface
  # ================================================================

  @doc """
  Read `key` (a string) off a node, trying the string key then the existing-atom
  key. `nil` for a non-map or an absent key. The one accessor the TUI shares.
  """
  @spec get(term(), String.t()) :: term()
  def get(m, key) when is_map(m), do: Map.get(m, key) || Map.get(m, safe_atom(key))
  def get(_m, _key), do: nil

  @doc "Write `key` => `value` on a node (string key). Identity for a non-map."
  @spec put(node_map(), String.t(), term()) :: node_map()
  def put(m, key, value) when is_map(m), do: Map.put(m, key, value)
  def put(other, _key, _value), do: other

  @doc "A node's children list (`[]` when absent). Always a list."
  @spec children(term()) :: [node_map()]
  def children(node), do: node |> get("children") |> List.wrap()

  @doc "Replace a node's children list."
  @spec put_children(node_map(), [node_map()]) :: node_map()
  def put_children(node, kids) when is_list(kids), do: put(node, "children", kids)

  @doc "The `\"slot\"` name of a node, or `nil`."
  @spec slot(term()) :: String.t() | nil
  def slot(node) do
    case get(node, "slot") do
      s when is_binary(s) -> s
      _ -> nil
    end
  end

  @doc "The `\"tags\"` map of a node (empty map when absent)."
  @spec tags(term()) :: map()
  def tags(node), do: get(node, "tags") || %{}

  @doc "Set the `\"tags\"` map on a node."
  @spec put_tags(node_map(), map()) :: node_map()
  def put_tags(node, t), do: put(node, "tags", t)

  @doc """
  The node `\"type\"` as a string (`\"split\"`, `\"pane\"`, `\"paragraph\"`, …),
  or `nil`. Atoms are stringified so a `:split`/`\"split\"` author agree.
  """
  @spec kind(term()) :: String.t() | nil
  def kind(node) do
    case get(node, "type") do
      t when is_binary(t) -> t
      t when is_atom(t) and not is_nil(t) -> Atom.to_string(t)
      _ -> nil
    end
  end

  @doc "Whether a term is a tree node we recurse into (a non-struct map)."
  @spec node?(term()) :: boolean()
  def node?(node), do: is_map(node) and not is_struct(node)

  # ================================================================
  # rose-tree traversal — the ONE recursion over "children"
  # ================================================================

  @doc """
  Pre-order fold over a node and its `"children"` descendants. `fun.(node, acc)`
  is applied at every node (the root and each descendant), parent before
  children. Structs and scalars are not nodes and are skipped.
  """
  @spec fold(term(), acc, (node_map(), acc -> acc)) :: acc when acc: term()
  def fold(node, acc, fun) when is_function(fun, 2) do
    cond do
      node?(node) ->
        acc = fun.(node, acc)
        Enum.reduce(children(node), acc, fn child, a -> fold(child, a, fun) end)

      is_list(node) ->
        Enum.reduce(node, acc, fn child, a -> fold(child, a, fun) end)

      true ->
        acc
    end
  end

  @doc """
  Collect every node (depth-first, pre-order) for which `pred` is true.
  """
  @spec collect(term(), pred()) :: [node_map()]
  def collect(node, pred) when is_function(pred, 1) do
    node
    |> fold([], fn n, acc -> if pred.(n), do: [n | acc], else: acc end)
    |> Enum.reverse()
  end

  @doc """
  The FIRST node (depth-first, pre-order) for which `pred` is true, or `nil`.
  Short-circuits — it does not walk the whole tree.
  """
  @spec find(term(), pred()) :: node_map() | nil
  def find(node, pred) when is_function(pred, 1) do
    cond do
      node?(node) ->
        if pred.(node) do
          node
        else
          Enum.find_value(children(node), fn child -> find(child, pred) end)
        end

      is_list(node) ->
        Enum.find_value(node, fn child -> find(child, pred) end)

      true ->
        nil
    end
  end

  @doc """
  Map `fun` over every node where `pred` is true, rebuilding the tree. `fun`
  receives the matching node and returns its replacement; the walk then continues
  into the (possibly replaced) node's children, so a replacement keeps its
  subtree unless `fun` rewrites it. Non-matching nodes are passed through but
  still recursed.
  """
  @spec update(term(), pred(), (node_map() -> node_map())) :: term()
  def update(node, pred, fun) when is_function(pred, 1) and is_function(fun, 1) do
    cond do
      node?(node) ->
        node = if pred.(node), do: fun.(node), else: node
        recurse_children(node, pred, fun)

      is_list(node) ->
        Enum.map(node, fn child -> update(child, pred, fun) end)

      true ->
        node
    end
  end

  @doc """
  Update the FIRST node matching `pred` (depth-first, pre-order) with `fun`,
  leaving every other node — including the matched node's own descendants —
  untouched. The single-target mirror of `update/3`.
  """
  @spec update_first(term(), pred(), (node_map() -> node_map())) :: term()
  def update_first(node, pred, fun) when is_function(pred, 1) and is_function(fun, 1) do
    {result, _done} = update_first_walk(node, pred, fun, false)
    result
  end

  defp update_first_walk(node, pred, fun, done) do
    cond do
      done ->
        {node, true}

      node?(node) ->
        if pred.(node) do
          {fun.(node), true}
        else
          {kids, done2} = update_first_list(children(node), pred, fun, false)
          {put_children(node, kids), done2}
        end

      is_list(node) ->
        update_first_list(node, pred, fun, done)

      true ->
        {node, done}
    end
  end

  defp update_first_list(list, pred, fun, done) do
    Enum.map_reduce(list, done, fn child, d -> update_first_walk(child, pred, fun, d) end)
  end

  defp recurse_children(node, pred, fun) do
    case children(node) do
      [] -> node
      kids -> put_children(node, Enum.map(kids, fn child -> update(child, pred, fun) end))
    end
  end

  # ================================================================
  # slot helpers — the common "address a node by its slot name" ops
  # ================================================================

  @doc "The node whose `\"slot\"` is `slot_name`, or `nil`."
  @spec at(term(), String.t()) :: node_map() | nil
  def at(tree, slot_name) when is_binary(slot_name),
    do: find(tree, fn n -> slot(n) == slot_name end)

  def at(_tree, _slot), do: nil

  @doc """
  Replace every node whose `"slot"` is `slot_name` by applying `fun` (slots are
  unique in practice, so this hits one). The slot tag is the caller's
  responsibility to preserve. Identity if absent.
  """
  @spec update_slot(term(), String.t(), (node_map() -> node_map())) :: term()
  def update_slot(tree, slot_name, fun) when is_binary(slot_name),
    do: update(tree, fn n -> slot(n) == slot_name end, fun)

  # ================================================================
  # path lenses — address a node/value deep in the tree (PLAN-021 W2)
  # ================================================================
  #
  # A PATH is a vector of segments resolved left-to-right from a starting node:
  #
  #   * a STRING segment  -> a map key (string-or-atom, via `get/2`),
  #   * an INTEGER segment -> if the current value is a LIST, its nth element;
  #     otherwise the current node's `children[i]` (the rose-tree child edge).
  #
  # So `[1 "tags" "focused"]` from a split = child 1, its tags map, key
  # "focused"; `["items" 2]` from a list widget = the 2nd item. The integer rule
  # lets the agent address a split child by index without spelling "children" —
  # the rose-tree mental model — while still indexing a plain value list.
  #
  # This is the composable optic the W2 `lens/update` / `lens/put` verbs ride on:
  # `get_path` is the lens `get`, `update_path`/`put_path` the lens `over`/`set`.
  # A missing/out-of-range segment fails CLEANLY: `get_path` -> nil,
  # `put_path`/`update_path` -> the tree unchanged (no partial mutation).

  @typedoc "A path segment: a string map-key or an integer index."
  @type segment :: String.t() | non_neg_integer()

  @doc "Read the value at `path` from `root`, or `nil` if any segment misses."
  @spec get_path(term(), [segment()]) :: term()
  def get_path(root, []), do: root
  def get_path(root, [seg | rest]), do: root |> step(seg) |> get_path(rest)

  @doc """
  Whether every segment of `path` resolves from `root`. The honest predicate
  behind a path write: `update_path`/`put_path` return the root unchanged on a
  missing segment, so a caller distinguishes "applied" from "no-op" with this,
  not by comparing trees (a fn that returns its input would look like a miss).
  An empty path always resolves (it addresses the root).
  """
  @spec path?(term(), [segment()]) :: boolean()
  def path?(_root, []), do: true

  def path?(root, [seg | rest]) do
    case fetch_step(root, seg) do
      {:ok, child} -> path?(child, rest)
      :error -> false
    end
  end

  @doc """
  Replace the value at `path` with `value`, returning the rebuilt root. The root
  is returned UNCHANGED if any segment is missing or out of range (no partial
  write). An empty path replaces the whole root.
  """
  @spec put_path(term(), [segment()], term()) :: term()
  def put_path(_root, [], value), do: value
  def put_path(root, path, value), do: update_path(root, path, fn _old -> value end)

  @doc """
  Apply `fun` to the value at `path`, returning the rebuilt root. The root is
  returned UNCHANGED if any segment is missing or out of range. An empty path
  applies `fun` to the whole root.
  """
  @spec update_path(term(), [segment()], (term() -> term())) :: term()
  def update_path(root, [], fun) when is_function(fun, 1), do: fun.(root)

  def update_path(root, [seg | rest], fun) when is_function(fun, 1) do
    case fetch_step(root, seg) do
      {:ok, child} -> set_step(root, seg, update_path(child, rest, fun))
      :error -> root
    end
  end

  # ---- one path segment ----

  # The value reached by one segment (nil if absent) — the lenient form `get_path`
  # rides on.
  defp step(value, seg) do
    case fetch_step(value, seg) do
      {:ok, v} -> v
      :error -> nil
    end
  end

  # A string segment reads a map key; an integer indexes a list directly, or the
  # node's children when the current value is a node map. {:ok, v} | :error.
  defp fetch_step(value, seg) when is_binary(seg) and is_map(value) do
    if has_key?(value, seg), do: {:ok, get(value, seg)}, else: :error
  end

  defp fetch_step(list, i) when is_list(list) and is_integer(i) and i >= 0 do
    case Enum.fetch(list, i) do
      {:ok, v} -> {:ok, v}
      :error -> :error
    end
  end

  defp fetch_step(node, i) when is_integer(i) and i >= 0 do
    if node?(node), do: fetch_step(children(node), i), else: :error
  end

  defp fetch_step(_value, _seg), do: :error

  # Write one segment's child back, mirroring `fetch_step`'s routing.
  defp set_step(value, seg, child) when is_binary(seg) and is_map(value),
    do: put(value, seg, child)

  defp set_step(list, i, child) when is_list(list) and is_integer(i),
    do: List.replace_at(list, i, child)

  defp set_step(node, i, child) when is_integer(i) do
    if node?(node), do: put_children(node, List.replace_at(children(node), i, child)), else: node
  end

  defp set_step(value, _seg, _child), do: value

  # Whether a node map carries `key` (string or existing-atom form).
  defp has_key?(m, key) when is_map(m) do
    Map.has_key?(m, key) or (safe_atom(key) != nil and Map.has_key?(m, safe_atom(key)))
  end

  # ================================================================
  # the one safe_atom — bounded, never interns
  # ================================================================

  @doc """
  The existing atom for a string key, or `nil` if no such atom exists. Uses
  `String.to_existing_atom/1` so a hostile key cannot grow the atom table — the
  single definition the TUI's accessors share (atom-DoS posture from `Ui.safe_*`).
  """
  @spec safe_atom(term()) :: atom() | nil
  def safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end

  def safe_atom(_), do: nil
end
