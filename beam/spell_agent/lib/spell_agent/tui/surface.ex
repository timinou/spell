defmodule SpellAgent.Tui.Surface do
  @moduledoc """
  The render mirror's recursive walk (PLAN-009): a layout TREE -> a flat list of
  `[{%Widget{}, %Rect{}}]` ready for `ExRatatui.draw/2`.

  This is the third mirror — `layout : tree -> widgets`, on the frame clock —
  beside the existing read mirror (`project/2`) and write mirror (`react/3`). It
  is a pure function of the tree plus the area it fills.

  ## The one shape, three node kinds

  Every node is a plain map (string- or atom-keyed). `"type"` selects the kind:

    * `"split"` — divides its rect via `ExRatatui.Layout.split/4` and lays each
      child into a sub-rect, recursively. Fields: `"dir"`
      (`"vertical"`/`"horizontal"`), `"constraints"` (a list of
      `["length" 3]`-style pairs), optional `"opts"` (flex/spacing/margin), and
      `"children"` (a list of nodes).

    * any reflected widget `"type"` (`"paragraph"`, `"list"`, `"block"`, ...) —
      a LEAF. `Materialize.to_struct/1` turns it into a real `%Widget{}` placed at
      the current rect. (A "pane" in the architecture doc is, at render time, just
      a leaf whose content was produced by a `view/` program — by the time the
      Surface walks the tree, a pane has already been reduced to widget leaves.)

  ## Failure posture (Edge B, per node)

  A node that fails to render (unknown type, bad constraints, a Materialize error)
  is SKIPPED — it contributes nothing to the frame rather than crashing the walk.
  The caller's per-slot failure ladder (LayoutRegistry) decides what to show
  instead at the slot granularity; here we simply never raise. This mirrors
  ExRatatui's own "a widget that raises is dropped" stance.

  Constraint pairs accept the PTC-native shapes the agent writes:
  `["length", 3]` / `[:length, 3]` / `["ratio", 1, 2]`, coerced to the
  `{:length, 3}` tuples `ExRatatui.Layout.split/4` expects.
  """

  alias ExRatatui.Layout
  alias ExRatatui.Layout.Rect
  alias SpellAgent.Tui.Materialize

  @typedoc "A placed widget ready for ExRatatui.draw/2."
  @type placement :: {struct(), Rect.t()}

  @doc """
  Render a layout `tree` into the `rect`, returning `[{widget, rect}]`.

  Never raises: a malformed subtree yields fewer placements, never a crash.
  """
  @spec render(term(), Rect.t()) :: [placement()]
  def render(tree, %Rect{} = rect), do: place(tree, rect)

  # ---- the recursive walk ----

  defp place(node, %Rect{} = rect) when is_map(node) do
    case kind(node) do
      "split" -> place_split(node, rect)
      nil -> []
      _widget_type -> place_leaf(node, rect)
    end
  rescue
    # A node that blows up contributes nothing rather than killing the frame.
    _ -> []
  end

  # A bare list of nodes at one rect (used when a slot returns multiple
  # top-level placements) — lay them all into the same rect.
  defp place(list, %Rect{} = rect) when is_list(list),
    do: Enum.flat_map(list, &place(&1, rect))

  defp place(_other, _rect), do: []

  # ---- split: divide the rect, recurse into children ----

  defp place_split(node, rect) do
    dir = direction(get(node, "dir"))
    constraints = constraints(get(node, "children"), get(node, "constraints"))
    opts = split_opts(get(node, "opts"))
    children = List.wrap(get(node, "children"))

    case Layout.split(rect, dir, constraints, opts) do
      rects when is_list(rects) ->
        children
        |> Enum.zip(rects)
        |> Enum.flat_map(fn {child, sub} -> place(child, sub) end)

      {:error, _} ->
        []
    end
  end

  # ---- leaf: materialize to a widget struct ----

  defp place_leaf(node, rect) do
    case Materialize.to_struct(node) do
      {:error, _} -> []
      widget -> [{widget, rect}]
    end
  end

  # ---- coercion helpers (PTC-native -> ex_ratatui forms) ----

  defp kind(node) do
    case get(node, "type") do
      t when is_binary(t) -> t
      t when is_atom(t) and not is_nil(t) -> Atom.to_string(t)
      _ -> nil
    end
  end

  defp direction("horizontal"), do: :horizontal
  defp direction(:horizontal), do: :horizontal
  defp direction(_), do: :vertical

  # Constraints: an explicit list wins; otherwise default to an even fill per
  # child so a split with children but no constraints still lays out sanely.
  defp constraints(_children, list) when is_list(list) and list != [],
    do: Enum.map(list, &constraint/1)

  defp constraints(children, _none) when is_list(children),
    do: List.duplicate({:fill, 1}, length(children))

  defp constraints(_children, _none), do: []

  # A constraint pair the agent writes: ["length", 3] / [:length, 3] /
  # ["ratio", 1, 2]. Coerce the kind to a known atom; anything unknown -> a
  # neutral fill so one bad entry doesn't sink the whole split.
  defp constraint([kind, a, b]), do: build_constraint(to_kind(kind), a, b)
  defp constraint([kind, a]), do: build_constraint(to_kind(kind), a, nil)
  defp constraint({kind, a}), do: build_constraint(to_kind(kind), a, nil)
  defp constraint({kind, a, b}), do: build_constraint(to_kind(kind), a, b)
  defp constraint(_), do: {:fill, 1}

  defp build_constraint(:length, n, _) when is_integer(n), do: {:length, n}
  defp build_constraint(:percentage, n, _) when is_integer(n), do: {:percentage, n}
  defp build_constraint(:min, n, _) when is_integer(n), do: {:min, n}
  defp build_constraint(:max, n, _) when is_integer(n), do: {:max, n}
  defp build_constraint(:fill, n, _) when is_integer(n), do: {:fill, n}
  defp build_constraint(:ratio, n, d) when is_integer(n) and is_integer(d), do: {:ratio, n, d}
  defp build_constraint(_, _, _), do: {:fill, 1}

  @constraint_kinds %{
    "length" => :length,
    "percentage" => :percentage,
    "min" => :min,
    "max" => :max,
    "fill" => :fill,
    "ratio" => :ratio
  }

  defp to_kind(k) when is_atom(k) and not is_nil(k), do: k
  defp to_kind(k) when is_binary(k), do: Map.get(@constraint_kinds, k)
  defp to_kind(_), do: nil

  # Split opts (flex/spacing/margin) — a string-keyed map from the agent. Only
  # known keys with valid values pass through; everything else is dropped.
  defp split_opts(m) when is_map(m) do
    []
    |> put_flex(get(m, "flex"))
    |> put_nni(:spacing, get(m, "spacing"))
    |> put_nni(:margin, get(m, "margin"))
    |> put_nni(:horizontal_margin, get(m, "horizontal_margin"))
    |> put_nni(:vertical_margin, get(m, "vertical_margin"))
  end

  defp split_opts(_), do: []

  @flexes %{
    "legacy" => :legacy,
    "start" => :start,
    "end" => :end,
    "center" => :center,
    "space_between" => :space_between,
    "space_around" => :space_around
  }

  defp put_flex(opts, f) when is_binary(f) do
    case Map.get(@flexes, f) do
      nil -> opts
      flex -> Keyword.put(opts, :flex, flex)
    end
  end

  defp put_flex(opts, _), do: opts

  defp put_nni(opts, key, n) when is_integer(n) and n >= 0, do: Keyword.put(opts, key, n)
  defp put_nni(opts, _key, _), do: opts

  # string- or atom-key fetch.
  defp get(m, key) when is_map(m) do
    Map.get(m, key) || Map.get(m, safe_atom(key))
  end

  defp get(_m, _key), do: nil

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end
end
