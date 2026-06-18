defmodule SpellAgent.Tui.ProjectionTest do
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.Projection

  # Two fake panes with different waking suffixes, recording each project call.
  defmodule TurnPane do
    use SpellAgent.Tui.Pane
    events([[:turn, :stop]])
    def project(forest, _), do: {:turns, map_size(forest)}
    def view(_), do: []
  end

  defmodule AlwaysPane do
    use SpellAgent.Tui.Pane
    # no events/0 override -> [] -> always dirty
    def project(forest, _), do: {:always, map_size(forest)}
    def view(_), do: []
  end

  defp panes do
    [
      %{name: :turns, module: TurnPane, assigns: %{}},
      %{name: :always, module: AlwaysPane, assigns: %{}}
    ]
  end

  test ":all forces every pane to project" do
    vms = Projection.reconcile(%{"a" => 1}, panes(), :all, %{})
    assert vms == %{turns: {:turns, 1}, always: {:always, 1}}
  end

  test "a dirty pane re-projects; a clean pane keeps its cached vm" do
    cache = %{turns: {:turns, 0}, always: {:always, 0}}

    # Only [:llm, :stop] fired: TurnPane is NOT dirty (keeps cache), AlwaysPane is.
    vms = Projection.reconcile(%{"a" => 1, "b" => 2}, panes(), [[:llm, :stop]], cache)

    assert vms.turns == {:turns, 0}, "clean pane kept cached vm"
    assert vms.always == {:always, 2}, "always-pane re-projected against new forest"
  end

  test "a matching suffix makes the pane dirty" do
    cache = %{turns: {:turns, 0}, always: {:always, 0}}
    vms = Projection.reconcile(%{"a" => 1, "b" => 2}, panes(), [[:turn, :stop]], cache)
    assert vms.turns == {:turns, 2}, "turn pane re-projected on its declared suffix"
  end
end
