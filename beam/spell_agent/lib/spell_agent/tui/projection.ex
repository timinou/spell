defmodule SpellAgent.Tui.Projection do
  @moduledoc """
  The mirror reconciler (PLAN-345) — forest -> per-pane view-models.

  This is the runtime half of the "Mirror DSL" idea: after every telemetry batch
  the App calls `reconcile/4`, which — for each pane — re-runs `project/2` ONLY if
  the pane is dirty (its `events/0` intersect the suffixes that fired this batch),
  otherwise keeps the cached view-model. The result is a `%{pane_name => vm}` map
  the App renders from.

  Re-keyed from Djinn LiveView's reconcile-after-every-callback to
  reconcile-after-every-telemetry-batch: same shape, different clock.

  A "pane spec" is the minimal descriptor the reconciler needs:

      %{name: atom(), module: module(), assigns: map()}

  `assigns` is the App's per-pane ui-state (cursor, selection, …) and is passed
  to `project/2` so a projection can be navigation-scoped (e.g. an aggregate over
  the selected subtree — PLAN-345 aggregates finding).
  """

  alias SpellAgent.Tui.Pane

  @type pane_spec :: %{name: atom(), module: module(), assigns: map()}
  @type vms :: %{optional(atom()) => term()}

  @doc """
  Reconcile every pane's view-model.

  * `forest` — the span forest (`%{id => Span.t()}`)
  * `panes`  — list of pane specs
  * `fired`  — telemetry suffixes that fired this batch (`[[:turn, :stop], …]`).
               Pass `:all` to force every pane to re-project (e.g. on first mount
               or after a navigation change that all panes may depend on).
  * `cache`  — the previous `vms` map (kept for non-dirty panes)
  """
  @spec reconcile(map(), [pane_spec()], [Pane.suffix()] | :all, vms()) :: vms()
  def reconcile(forest, panes, fired, cache \\ %{}) do
    reconcile(forest, panes, fired, cache, :all)
  end

  @doc """
  Reconcile with a RADIUS hint (PLAN-025 W3, FEAT-038).

  Same as `reconcile/4`, but `dirty_paths` (root-paths of the spans that changed
  this batch, or `:all`) is threaded to each dirty pane's `project_incremental/3`
  so a pane may recompute only the affected subtrees. A pane that does not
  override `project_incremental/3` behaves exactly as before (full `project/2`),
  so this is a strict superset of `reconcile/4` — nothing regresses.

  The App computes `dirty_paths` from `SpellAgent.Tui.ForestDiff.dirty_paths/2`
  (prev vs curr forest); on first mount / navigation it passes `:all`.
  """
  @spec reconcile(map(), [pane_spec()], [Pane.suffix()] | :all, vms(), [[String.t()]] | :all) ::
          vms()
  def reconcile(forest, panes, fired, cache, dirty_paths) do
    Enum.reduce(panes, %{}, fn %{name: name, module: mod, assigns: assigns}, acc ->
      vm =
        if reproject?(mod, fired) do
          mod.project_incremental(forest, assigns, dirty_paths)
        else
          Map.get(cache, name)
        end

      Map.put(acc, name, vm)
    end)
  end

  defp reproject?(_mod, :all), do: true
  defp reproject?(mod, fired), do: Pane.dirty?(mod, fired)
end
