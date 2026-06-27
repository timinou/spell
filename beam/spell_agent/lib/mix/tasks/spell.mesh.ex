defmodule Mix.Tasks.Spell.Mesh do
  @shortdoc "Inspect the agent mesh — regions, boards, and folds"

  @moduledoc """
  Inspect the stigmergic blackboard (PROJ-006, FEAT-014/015, PLAN-019 M4).

  Stdout modes (safe anywhere):

      mix spell.mesh                      # list every region + its record counts
      mix spell.mesh --region ID          # print one region's board (all records)
      mix spell.mesh --fold ID:kind:reduce # fold a region (count|group-by|rank|…)

  `--fold` parses `REGION:KIND:REDUCE` (e.g. `r1:finding:count`). KIND is a record
  kind (finding|goal|claim|verdict|intention|decision|resolution) or `*` for all;
  REDUCE is a `black/fold` reducer (`count`, or `group-by:FIELD`, `rank:FIELD`).

  The interactive TUI inspector (the Regions/Board/Spawn panes) is FUP-025; this
  task ships the queryable stdout surface over `Mesh.Store`, the data half both the
  CLI and a future TUI share via `Mesh.MeshView`.

  Reflects the configured `Hist` store (Memory default, Khepri when configured) —
  mesh records ride the same store as conversation history.
  """

  use Mix.Task

  alias SpellAgent.Hist
  alias SpellAgent.Mesh.MeshView
  alias SpellAgent.Mesh.Namespace
  alias SpellAgent.Mesh.Store, as: MeshStore

  @requirements ["app.start"]

  @switches [region: :string, fold: :string]

  @impl Mix.Task
  def run(args) do
    {opts, _rest, _invalid} = OptionParser.parse(args, switches: @switches)

    cond do
      is_binary(opts[:fold]) -> print_fold(opts[:fold])
      is_binary(opts[:region]) -> print_region(opts[:region])
      true -> print_regions()
    end
  end

  defp store, do: Hist.default_store()

  # ---- region index ----

  defp print_regions do
    store()
    |> MeshStore.regions()
    |> MeshView.regions_text()
    |> Mix.shell().info()
  end

  # ---- one region's board ----

  defp print_region(region) do
    records = MeshStore.region(store(), region)

    region
    |> MeshView.board_text(records)
    |> Mix.shell().info()
  end

  # ---- fold ----

  # Parse REGION:KIND:REDUCE and run it through the black/fold verb (the SAME fold
  # logic the agent uses — never a parallel impl). KIND `*` -> all kinds (no :over).
  defp print_fold(spec) do
    case parse_fold(spec) do
      {:ok, region, kind, reduce, field} ->
        verbs = Namespace.tools(store(), "mesh-cli", region, held: [region])
        args = fold_args(kind, reduce, field)

        verbs["black/fold"].(args)
        |> MeshView.fold_text()
        |> Mix.shell().info()

      {:error, msg} ->
        Mix.shell().error(msg)
    end
  end

  # REGION:KIND:REDUCE where REDUCE may itself be REDUCER:FIELD (group-by:risk).
  defp parse_fold(spec) do
    case String.split(spec, ":", parts: 3) do
      [region, kind, reduce_spec] when region != "" ->
        {reduce, field} = parse_reduce(reduce_spec)
        {:ok, region, kind, reduce, field}

      _ ->
        {:error,
         "--fold expects REGION:KIND:REDUCE (e.g. r1:finding:count or " <>
           "r1:finding:group-by:risk); got #{inspect(spec)}"}
    end
  end

  # A reducer may carry a field: "group-by:risk" / "rank:score" -> {reducer, field}.
  defp parse_reduce(reduce_spec) do
    case String.split(reduce_spec, ":", parts: 2) do
      [reducer, field] -> {reducer, field}
      [reducer] -> {reducer, nil}
    end
  end

  defp fold_args(kind, reduce, field) do
    base = %{"reduce" => reduce}
    base = if kind == "*", do: base, else: Map.put(base, "over", kind)
    if is_binary(field), do: Map.put(base, "field", field), else: base
  end
end
