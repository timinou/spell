defmodule SpellAgent.Tui.Render do
  @moduledoc """
  Total, side-effect-light node RESOLUTION for the inspector render path
  (PLAN-025 W3, FEAT-041).

  Extracted verbatim from the former `SpellAgent.Tui.App` god-module. Given a
  placed layout leaf (`{node, rect}`) and the current App `state`, resolve it to
  a list of concrete `{widget, rect}` placements. Two totality guards live here
  (the SINGLE render contract, BUG-009/BUG-010):

    * `safe_resolve_node/3` makes resolution TOTAL — a raise drops just this
      node's leaves (a GAP), never the whole frame.
    * `encodable_placement?/1` makes the encode TOTAL — an unencodable widget is
      dropped, not raised (one missing widget beats a frozen screen).

  Keeping these pure (state in, placements out) lets `App.render/2` be
  unit-tested directly and gives the incremental-reproject work (FEAT-038) a
  clean, isolated resolution seam to target.
  """

  require Logger

  alias SpellAgent.Tui.{DefaultLayout, Lens, Materialize, PaneWidget, Ui}

  @doc """
  Resolve a placed leaf node to `[{widget, rect}]`, TOTALLY: a raise while
  resolving (a malformed node, a pane `view/1` blowup, a `Materialize` failure)
  drops just this node's leaves and logs, rather than killing the frame.
  """
  @spec safe_resolve_node(map(), term(), map()) :: [{term(), term()}]
  def safe_resolve_node(node, rect, state) do
    resolve_node(node, rect, state)
  rescue
    e ->
      Logger.warning(
        "render: dropped node #{inspect(Lens.slot(node) || Map.get(node, "type"))}: #{Exception.message(e)}"
      )

      []
  catch
    _, _ -> []
  end

  @doc """
  The encode gate (BUG-008): probe a placed widget with the SAME call the draw
  loop makes; `true` iff the Bridge can encode it. Drop the offenders so a single
  unencodable widget never drops the whole frame.
  """
  @spec encodable_placement?(term()) :: boolean()
  def encodable_placement?({widget, %{__struct__: _} = rect}) do
    ExRatatui.Bridge.encode_command({widget, rect})
    true
  rescue
    _ -> false
  catch
    _, _ -> false
  end

  def encodable_placement?(_), do: false

  # Resolve a placed leaf node to [{widget, rect}]. One resolution path
  # (PLAN-012 W5 dogfood): every node — status, composer, an agent shadow, a
  # pane — resolves by its TYPE.
  defp resolve_node(node, rect, state) do
    resolve_by_type(node, rect, state)
  end

  defp resolve_by_type(node, rect, state) do
    case Map.get(node, "type") do
      "pane" -> resolve_pane(node, rect, state)
      _ -> materialize_widget(node, rect)
    end
  end

  # A native pane node -> run its module's view over the projected vm + gaze,
  # then materialize each descriptor into a widget.
  defp resolve_pane(node, rect, state) do
    slot = Lens.slot(node)
    name = safe_pane_name(slot)
    mod = DefaultLayout.pane_module(slot)

    if is_nil(name) or is_nil(mod) do
      []
    else
      vm = Map.get(state.vms, name)
      focused? = state.ui.focus == name
      assigns = %{ui: state.ui, cursor: Ui.cursor_of(state.ui, name)}

      %{vm: vm, rect: rect, assigns: assigns, focused?: focused?}
      |> mod.view()
      |> Enum.map(&PaneWidget.run/1)
    end
  end

  # An agent-authored widget leaf -> Materialize -> %Widget{} (or skip on error).
  defp materialize_widget(node, rect) do
    case Materialize.to_struct(node) do
      {:error, _} -> []
      widget -> [{widget, rect}]
    end
  end

  defp safe_pane_name(slot) when is_binary(slot), do: Ui.safe_pane(slot)
  defp safe_pane_name(_), do: nil
end
