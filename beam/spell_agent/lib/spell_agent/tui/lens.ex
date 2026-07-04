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

  alias ExRatatui.Layout.Rect
  alias SpellAgent.Tui.{Spatial, Surface, Tree, Ui}

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
      "lens/tag" => fn args -> tag_focused(tree, get(args, "key"), get(args, "value")) end,
      "lens/frame-target" => fn args -> frame_target_tool(tree, args) end
    }
  end

  # ================================================================
  # spatial focus (C-w) as a PTC verb -- PLAN-024 Wave 2 (FUP-031)
  # ================================================================
  #
  # `App.frame_target/2` (the native C-w) and this verb are now BOTH thin
  # callers of the SAME `pane_regions/3` + `Spatial.extreme/2` pair -- one
  # source of truth for "which region is spatially extreme", reachable from
  # BOTH the compiled keybinding and an agent-authored `keymap/define-reaction`.
  # This is the concrete generalization: an agent can reproduce today's native
  # `C-w l` PURELY in PTC (no Elixir change) by calling `lens/frame-target`.

  @default_frame_width 80
  @default_frame_height 24

  @doc """
  The slot of the region spatially EXTREME along `dir`, laid out from `tree`
  into `area` (holes resolved against `data_env` first). Pure composition of
  `pane_regions/3` + `Spatial.extreme/2` -- the SAME pair `App.frame_target/2`
  calls, so a `lens/frame-target` verb and the native `C-w` keybinding can never
  diverge (one source of truth, not two copies of the geometry logic).

  `nil` when nothing is placed (a degraded tree) or `dir` doesn't parse --
  total, never raises.
  """
  @spec frame_target(node_map(), Spatial.direction(), Rect.t(), map()) :: String.t() | nil
  def frame_target(tree, dir, %Rect{} = area, data_env \\ %{}) when is_atom(dir) do
    tree |> pane_regions(area, data_env) |> Spatial.extreme(dir)
  end

  @doc """
  `[{slot, %Rect{}}]` for every FOCUSABLE region in `tree`, laid out into `area`
  (`tmpl::` holes resolved against `data_env` first, default `%{}`). The shared
  geometry primitive behind BOTH `App.frame_regions/1` (production, with the
  App-only cells-drawer overlay appended by the caller) and `frame_target/4`
  (the PTC verb, body panes only -- an authored program has no App-only
  drawer-flag state to append).

  A region qualifies the SAME way the ring does: `Lens.slot/1` present AND
  `Ui.safe_pane/1` recognizes it (fixed vocabulary OR a `PaneRegistry`-declared
  runtime pane -- PLAN-024 Wave 1). Best-effort: any layout failure degrades to
  `[]` rather than raising into the caller's event loop.
  """
  @spec pane_regions(node_map(), Rect.t(), map()) :: [{String.t(), Rect.t()}]
  def pane_regions(tree, %Rect{} = area, data_env \\ %{}) do
    tree
    |> Surface.resolve_holes(data_env)
    |> Surface.layout(area)
    |> Enum.flat_map(fn {node, rect} ->
      case slot(node) do
        s when is_binary(s) -> if Ui.safe_pane(s), do: [{s, rect}], else: []
        _ -> []
      end
    end)
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  # `lens/frame-target {:dir "left"|"right"|"up"|"down" :width :height :data}` --
  # the PTC-callable form. `area` defaults to an 80x24 rect (mirrors
  # `RenderProbe`'s convention) since a reaction has no live frame area to read;
  # pass `:width`/`:height` to match the real terminal when it matters. An
  # unparseable `:dir` yields nil rather than erroring (mirrors `Spatial.extreme`'s
  # own totality).
  defp frame_target_tool(tree, args) do
    case Spatial.direction(get(args, "dir")) do
      nil ->
        nil

      dir ->
        area = %Rect{
          x: 0,
          y: 0,
          width: positive_int(get(args, "width"), @default_frame_width),
          height: positive_int(get(args, "height"), @default_frame_height)
        }

        data_env = get(args, "data") || %{}
        frame_target(tree, dir, area, data_env)
    end
  end

  defp positive_int(n, _default) when is_integer(n) and n > 0, do: n
  defp positive_int(_n, default), do: default

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
  defdelegate at(tree, slot_name), to: Tree

  @doc """
  Replace the node at `slot` with `replacement` (slot tag preserved). Pure
  tree -> tree; the tree is returned unchanged if the slot is absent. The mirror
  of `at/2` for writes.
  """
  @spec put_at(node_map(), String.t(), node_map()) :: node_map()
  def put_at(tree, slot_name, replacement)
      when is_binary(slot_name) and is_map(replacement) do
    update_node(tree, slot_name, fn _old -> Map.put(replacement, "slot", slot_name) end)
  end

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
  # tree mechanics -- delegated to the canonical `Tui.Tree` (PLAN-021 W1)
  # ================================================================
  #
  # The rose-tree recursion + the string-or-atom Node accessor live ONCE, in
  # `Tui.Tree`. Lens keeps only the gaze-specific wrappers (pane filtering, the
  # focus ring) and delegates every walk/accessor to Tree -- so the four
  # hand-rolled recursions (collect/find_node/map_pane_nodes/update_node) and the
  # private `safe_atom`/`get` copy are gone.

  @doc "The tags map of a node (string-keyed; empty map if none)."
  @spec tags(node_map()) :: map()
  defdelegate tags(node), to: Tree

  @doc "The slot name of a node, or nil."
  @spec slot(node_map()) :: String.t() | nil
  defdelegate slot(node), to: Tree

  defp put_tags(node, t), do: Tree.put_tags(node, t)

  defp children(node), do: Tree.children(node)

  # A node joins the focus ring iff `focusable?/1` says so (PLAN-024 Wave 1: a
  # `tags["focusable"]` flag, now actually consulted). Native `"pane"` nodes are
  # focusable BY DEFAULT (opt-out via an explicit `tags["focusable"] == false`);
  # any OTHER node kind (an agent-authored `view/*` widget shadowing a body slot)
  # is focusable only by explicit OPT-IN (`tags["focusable"] == true`) — a plain
  # content widget never silently joins the ring.
  defp focusable?(n) do
    case {kind(n), get(tags(n), "focusable")} do
      {"pane", false} -> false
      {"pane", _} -> true
      {_, true} -> true
      _ -> false
    end
  end

  defp pane_nodes(tree), do: Tree.collect(tree, &focusable?/1)

  defp map_pane_nodes(tree, fun),
    do: Tree.update(tree, &focusable?/1, fun)

  defp update_node(tree, slot_name, fun), do: Tree.update_slot(tree, slot_name, fun)

  # ---- helpers ----

  defp kind(node), do: Tree.kind(node)

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

  defp get(m, key), do: Tree.get(m, key)

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
end
