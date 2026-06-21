defmodule SpellAgent.Tui.Lens do
  @moduledoc """
  The gaze/render unification (PLAN-009, D1) -- navigation as a LENS over the
  layout tree.

  The keystone of the freeform design: there is no longer a `%Ui{}` struct living
  BESIDE the render tree. There is ONE layout tree, and navigation is a traversal
  that RE-TAGS its nodes. Focus, cursor, scroll, collapse, mode -- every piece of
  the old gaze is now a TAG on the node it describes:

    * root node tags -- `mode`, `auto_depth`, `overrides`, `turn`, `leader`
      (the gaze state that isn't spatial), plus `ring` (the ordered focusable
      slot names).
    * pane node tags -- `focused` (a boolean; at most one pane true), `cursor`,
      `scroll` (the spatial gaze, on the pane it belongs to).

  ## Why `%Ui{}` still exists (the round-trip)

  The existing panes (`SpanTree`, `Detail`, `History`) and the reaction algebra
  (`Keys.dispatch` -> `Pane.react/3`) are written against `%Ui{}` and covered by
  168 tests. So `%Ui{}` becomes a DERIVED, round-tripping VIEW of the tree:

      to_ui(tree)        -- materialize the gaze from the tree's tags
      from_ui(tree, ui)  -- fold a reaction's new %Ui{} BACK into the tree's tags

  The tree is canonical; `%Ui{}` is a transient projection the reaction algebra
  speaks. Intra-pane navigation (cursor drill, scroll) flows through the rich,
  forest-aware pane reactions (then `from_ui` writes the result back). Inter-pane
  navigation (the focus RING) and structure are pure `lens/` re-tags of the tree.

  ## The `lens/` PTC surface

  `tools/1` exposes the traversal verbs as the `lens/` namespace (ptc_runner
  PATCH-O). Pure tree -> tree, bounded: slot names match the tree's OWN ring (no
  interning), carrying the `Ui.safe_*` atom-DoS posture onto the tree.
  """

  alias SpellAgent.Tui.Ui

  @typedoc "A layout tree node (plain string-keyed map)."
  @type node_map :: %{optional(String.t()) => term()}

  @doc """
  Build the gaze-bearing root tags from a `%Ui{}` -- used when seeding a fresh
  tree from a starting gaze. Returns a string-keyed tag map.
  """
  @spec root_tags(Ui.t()) :: map()
  def root_tags(%Ui{} = ui) do
    %{
      "mode" => Atom.to_string(ui.mode),
      "auto_depth" => ui.auto_depth,
      "overrides" => stringify_overrides(ui.overrides),
      "turn" => ui.turn,
      "leader" => ui.leader && Atom.to_string(ui.leader),
      "ring" => Enum.map(ui.panes, &Atom.to_string/1)
    }
  end

  @doc "Pane tags for a pane from a `%Ui{}` (focused?/cursor/scroll)."
  @spec pane_tags(Ui.t(), atom()) :: map()
  def pane_tags(%Ui{} = ui, pane) do
    %{
      "focused" => ui.focus == pane,
      "cursor" => Ui.cursor_of(ui, pane),
      "scroll" => Ui.scroll_of(ui, pane)
    }
  end

  # ================================================================
  # to_ui / from_ui -- the round-trip with the reaction algebra
  # ================================================================

  @doc """
  Materialize a `%Ui{}` from the tree's tags -- the derived gaze the existing pane
  reactions and projections consume. Every field coerced through `Ui.safe_*`.
  """
  @spec to_ui(node_map()) :: Ui.t()
  def to_ui(tree) when is_map(tree) do
    rtags = tags(tree)
    panes = pane_nodes(tree)

    ring =
      rtags
      |> get("ring")
      |> List.wrap()
      |> Enum.flat_map(fn s -> List.wrap(Ui.safe_pane(s)) end)

    focus =
      Enum.find_value(panes, fn p ->
        if get(tags(p), "focused") == true, do: Ui.safe_pane(slot(p))
      end)

    cursors = pane_index(panes, "cursor")
    scroll = pane_index(panes, "scroll")

    %Ui{
      focus: focus || List.first(ring) || :tree,
      panes: if(ring == [], do: Ui.new().panes, else: ring),
      mode: Ui.safe_mode(get(rtags, "mode")) || :normal,
      cursors: cursors,
      auto_depth: int(get(rtags, "auto_depth"), 1),
      overrides: parse_overrides(get(rtags, "overrides")),
      turn: int(get(rtags, "turn"), 0),
      scroll: scroll,
      leader: Ui.safe_pane(get(rtags, "leader"))
    }
  end

  # name => integer-tag index over the pane nodes (cursors / scroll maps).
  defp pane_index(panes, key) do
    for p <- panes, name = Ui.safe_pane(slot(p)), name != nil, into: %{} do
      {name, int(get(tags(p), key), 0)}
    end
  end

  @doc """
  Fold a reaction's new `%Ui{}` BACK into the tree's tags -- the inverse of
  `to_ui/1`. The tree stays canonical; this writes the gaze delta onto it.
  """
  @spec from_ui(node_map(), Ui.t()) :: node_map()
  def from_ui(tree, %Ui{} = ui) when is_map(tree) do
    tree
    |> put_tags(Map.merge(tags(tree), root_tags(ui)))
    |> map_pane_nodes(fn pane ->
      case Ui.safe_pane(slot(pane)) do
        nil -> pane
        name -> put_tags(pane, Map.merge(tags(pane), pane_tags(ui, name)))
      end
    end)
  end

  # ================================================================
  # lens/ traversal verbs (PTC surface) -- pure tree -> tree
  # ================================================================

  @doc """
  The `lens/` tool entries (qualified name => `(args -> term)`). `tree` closes
  over the CURRENT tree so a verb called with `{}` acts on it.
  """
  @spec tools(node_map()) :: %{optional(String.t()) => (map() -> term())}
  def tools(tree) when is_map(tree) do
    %{
      "lens/focus" => fn args -> focus(tree, dir_arg(args)) end,
      "lens/focused" => fn _args -> focused(tree) end,
      "lens/focusables" => fn _args -> focusables(tree) end,
      "lens/at" => fn args -> at(tree, get(args, "slot")) end,
      "lens/tag" => fn args -> tag_focused(tree, get(args, "key"), get(args, "value")) end
    }
  end

  @doc """
  Move the `:focused` tag through the ring, or to a named slot. `:next` | `:prev`
  step the ring; a slot string jumps directly. Pure tree -> tree.
  """
  @spec focus(node_map(), :next | :prev | String.t()) :: node_map()
  def focus(tree, dir) do
    ring = focusables(tree)

    case target_slot(tree, ring, dir) do
      nil -> tree
      target -> set_focus(tree, target)
    end
  end

  @doc "The currently-focused pane node, or nil."
  @spec focused(node_map()) :: node_map() | nil
  def focused(tree) do
    Enum.find(pane_nodes(tree), fn p -> get(tags(p), "focused") == true end)
  end

  @doc "The ordered focusable slot names (the ring) -- pane nodes, in tree order."
  @spec focusables(node_map()) :: [String.t()]
  def focusables(tree) do
    tree |> pane_nodes() |> Enum.map(&slot/1) |> Enum.reject(&is_nil/1)
  end

  @doc """
  The ordered slot names of the BODY split's direct children -- the STABLE pane
  identities, in tree order.

  Unlike `focusables/1`, this does not depend on a child still being a `"pane"`
  node: when the agent shadows a pane slot (e.g. `detail`) with a custom widget,
  the widget keeps the slot name but loses `type: "pane"`, so it drops out of
  `focusables/1`. The render-adoption gate must key off this stable identity, or
  a pane shadow silently un-adopts the whole live tree (PLAN-009 / BUG-007).

  Returns `[]` when there is no `body` split (degraded / unexpected tree).
  """
  @spec body_pane_slots(node_map()) :: [String.t()]
  def body_pane_slots(tree) do
    case at(tree, "body") do
      %{} = body ->
        body |> children() |> List.wrap() |> Enum.map(&slot/1) |> Enum.reject(&is_nil/1)

      _ ->
        []
    end
  end

  @doc "The node at `slot`, or nil."
  @spec at(node_map(), term()) :: node_map() | nil
  def at(tree, slot_name) when is_binary(slot_name) do
    find_node(tree, fn n -> slot(n) == slot_name end)
  end

  def at(_tree, _slot), do: nil

  @doc "Set a tag on the focused pane node. Pure tree -> tree."
  @spec tag_focused(node_map(), term(), term()) :: node_map()
  def tag_focused(tree, key, value) when is_binary(key) do
    case focused(tree) do
      nil -> tree
      pane -> update_node(tree, slot(pane), fn n -> put_tags(n, Map.put(tags(n), key, value)) end)
    end
  end

  def tag_focused(tree, _key, _value), do: tree

  # ---- focus helpers ----

  defp target_slot(tree, ring, :next), do: ring_step(tree, ring, +1)
  defp target_slot(tree, ring, :prev), do: ring_step(tree, ring, -1)
  defp target_slot(_tree, ring, slot) when is_binary(slot), do: slot in ring && slot
  defp target_slot(_tree, _ring, _), do: nil

  defp ring_step(_tree, [], _delta), do: nil

  defp ring_step(tree, ring, delta) do
    f = focused(tree)
    cur = f && slot(f)
    idx = Enum.find_index(ring, &(&1 == cur)) || 0
    Enum.at(ring, Integer.mod(idx + delta, length(ring)))
  end

  defp set_focus(tree, target) do
    map_pane_nodes(tree, fn p ->
      put_tags(p, Map.put(tags(p), "focused", slot(p) == target))
    end)
  end

  # ================================================================
  # tree mechanics (hand-rolled over plain maps -- no zipper dependency)
  # ================================================================

  @doc "The tags map of a node (string-keyed; empty map if none)."
  @spec tags(node_map()) :: map()
  def tags(node) when is_map(node), do: get(node, "tags") || %{}
  def tags(_), do: %{}

  @doc "The slot name of a node, or nil."
  @spec slot(node_map()) :: String.t() | nil
  def slot(node) when is_map(node) do
    case get(node, "slot") do
      s when is_binary(s) -> s
      _ -> nil
    end
  end

  def slot(_), do: nil

  defp put_tags(node, t), do: put(node, "tags", t)

  defp children(node), do: get(node, "children") || []

  defp pane_nodes(tree), do: collect(tree, fn n -> kind(n) == "pane" end)

  defp collect(node, pred) when is_map(node) do
    here = if pred.(node), do: [node], else: []
    here ++ Enum.flat_map(List.wrap(children(node)), fn c -> collect(c, pred) end)
  end

  defp collect(list, pred) when is_list(list),
    do: Enum.flat_map(list, fn c -> collect(c, pred) end)

  defp collect(_other, _pred), do: []

  defp find_node(node, pred) when is_map(node) do
    if pred.(node) do
      node
    else
      Enum.find_value(List.wrap(children(node)), fn c -> find_node(c, pred) end)
    end
  end

  defp find_node(list, pred) when is_list(list),
    do: Enum.find_value(list, fn c -> find_node(c, pred) end)

  defp find_node(_other, _pred), do: nil

  defp map_pane_nodes(node, fun) when is_map(node) do
    node = if kind(node) == "pane", do: fun.(node), else: node

    case children(node) do
      [] -> node
      kids -> put(node, "children", Enum.map(kids, fn c -> map_pane_nodes(c, fun) end))
    end
  end

  defp map_pane_nodes(other, _fun), do: other

  defp update_node(node, slot_name, fun) when is_map(node) do
    node = if slot(node) == slot_name, do: fun.(node), else: node

    case children(node) do
      [] -> node
      kids -> put(node, "children", Enum.map(kids, fn c -> update_node(c, slot_name, fun) end))
    end
  end

  defp update_node(other, _slot, _fun), do: other

  # ---- helpers ----

  defp kind(node) when is_map(node) do
    case get(node, "type") do
      t when is_binary(t) -> t
      t when is_atom(t) and not is_nil(t) -> Atom.to_string(t)
      _ -> nil
    end
  end

  defp kind(_), do: nil

  defp dir_arg(args) do
    case get(args, "dir") do
      "next" -> :next
      "prev" -> :prev
      :next -> :next
      :prev -> :prev
      slot when is_binary(slot) -> slot
      _ -> :next
    end
  end

  defp get(m, key) when is_map(m), do: Map.get(m, key) || Map.get(m, safe_atom(key))
  defp get(_m, _key), do: nil

  defp put(m, key, value) when is_map(m), do: Map.put(m, key, value)

  defp int(v, default)
  defp int(n, _default) when is_integer(n) and n >= 0, do: n
  defp int(_v, default), do: default

  defp stringify_overrides(ov) when is_map(ov) do
    Map.new(ov, fn {k, v} -> {to_string(k), Atom.to_string(v)} end)
  end

  defp parse_overrides(ov) when is_map(ov) do
    for {k, v} <- ov, vis = Ui.safe_visibility(v), vis != nil, into: %{}, do: {to_string(k), vis}
  end

  defp parse_overrides(_), do: %{}

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end

  defp safe_atom(_), do: nil
end
