defmodule SpellAgent.Tui.SplitSpec do
  @moduledoc """
  The PTC-native → `ExRatatui.Layout` coercion for a `"split"` node (PLAN-021 W1).

  A split node carries agent-authored, string-or-atom shaped fields — `"dir"`,
  `"constraints"` (pairs like `["length", 3]` / `[:percentage, 50]` /
  `["ratio", 1, 2]`), and `"opts"` (flex/spacing/margins). Turning those into the
  `{:length, 3}` tuples + keyword opts that `ExRatatui.Layout.split/4` expects is
  PURE coercion with a fixed, forgiving contract (an unknown entry degrades to a
  neutral `{:fill, 1}` rather than crashing the split).

  This logic was duplicated VERBATIM in `Surface` (the live render walk) and
  `LayoutDiagnostic` (the authoring-time validator) — the latter's own comment
  read "coercion helpers kept in sync with Surface". Two copies of one contract
  drift; this is the single source both delegate to.
  """

  alias SpellAgent.Tui.Tree

  @constraint_kinds %{
    "length" => :length,
    "percentage" => :percentage,
    "min" => :min,
    "max" => :max,
    "fill" => :fill,
    "ratio" => :ratio
  }

  @flexes %{
    "legacy" => :legacy,
    "start" => :start,
    "end" => :end,
    "center" => :center,
    "space_between" => :space_between,
    "space_around" => :space_around
  }

  @doc "Split direction from a `\"dir\"` value (`:horizontal`/`:vertical`)."
  @spec direction(term()) :: :horizontal | :vertical
  def direction("horizontal"), do: :horizontal
  def direction(:horizontal), do: :horizontal
  def direction(_), do: :vertical

  @doc """
  The constraint tuples for a split: an explicit `"constraints"` list wins
  (coerced pair-by-pair); otherwise an even `{:fill, 1}` per child so a split
  with children but no constraints still lays out. `[]` when neither applies.
  """
  @spec constraints([term()] | term(), term()) :: [tuple()]
  def constraints(_children, list) when is_list(list) and list != [],
    do: Enum.map(list, &constraint/1)

  def constraints(children, _none) when is_list(children),
    do: List.duplicate({:fill, 1}, length(children))

  def constraints(_children, _none), do: []

  @doc """
  Coerce ONE constraint pair the agent writes (`["length", 3]` / `[:length, 3]`
  / `["ratio", 1, 2]`) to a `Layout` tuple. An unknown kind/shape → `{:fill, 1}`.
  """
  @spec constraint(term()) :: tuple()
  def constraint([kind, a, b]), do: build_constraint(to_kind(kind), a, b)
  def constraint([kind, a]), do: build_constraint(to_kind(kind), a, nil)
  def constraint({kind, a}), do: build_constraint(to_kind(kind), a, nil)
  def constraint({kind, a, b}), do: build_constraint(to_kind(kind), a, b)
  def constraint(_), do: {:fill, 1}

  @doc """
  Split opts (flex/spacing/margins) from a string-keyed `\"opts\"` map. Only
  known keys with valid values pass through; everything else is dropped. `[]`
  for a non-map.
  """
  @spec split_opts(term()) :: keyword()
  def split_opts(m) when is_map(m) do
    []
    |> put_flex(Tree.get(m, "flex"))
    |> put_nni(:spacing, Tree.get(m, "spacing"))
    |> put_nni(:margin, Tree.get(m, "margin"))
    |> put_nni(:horizontal_margin, Tree.get(m, "horizontal_margin"))
    |> put_nni(:vertical_margin, Tree.get(m, "vertical_margin"))
  end

  def split_opts(_), do: []

  # ---- internals ----

  defp build_constraint(:length, n, _) when is_integer(n), do: {:length, n}
  defp build_constraint(:percentage, n, _) when is_integer(n), do: {:percentage, n}
  defp build_constraint(:min, n, _) when is_integer(n), do: {:min, n}
  defp build_constraint(:max, n, _) when is_integer(n), do: {:max, n}
  defp build_constraint(:fill, n, _) when is_integer(n), do: {:fill, n}
  defp build_constraint(:ratio, n, d) when is_integer(n) and is_integer(d), do: {:ratio, n, d}
  defp build_constraint(_, _, _), do: {:fill, 1}

  defp to_kind(k) when is_atom(k) and not is_nil(k), do: k
  defp to_kind(k) when is_binary(k), do: Map.get(@constraint_kinds, k)
  defp to_kind(_), do: nil

  defp put_flex(opts, f) when is_binary(f) do
    case Map.get(@flexes, f) do
      nil -> opts
      flex -> Keyword.put(opts, :flex, flex)
    end
  end

  defp put_flex(opts, _), do: opts

  defp put_nni(opts, key, n) when is_integer(n) and n >= 0, do: Keyword.put(opts, key, n)
  defp put_nni(opts, _key, _), do: opts
end
