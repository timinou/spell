defmodule SpellAgent.Integration.SceneStoreTest do
  @moduledoc """
  Integration test (PLAN-347): every gallery scene, replayed as REAL telemetry
  through `SceneTelemetry.emit/2`, must reconstruct in a live `SpellAgent.Tui.Store`
  with the SAME shape as its fixture forest.

  This closes the loop on the visual layer: the snapshot test proves the scenes
  RENDER correctly, and this proves the scenes are FAITHFUL to what genuine
  `[:ptc_runner, :sub_agent, …]` telemetry builds — so a baseline can never drift
  into testing a forest the Store could never actually produce. It simultaneously
  exercises the Store's own event handling (parent/child linking, status
  propagation, turn folding) end to end.

  `async: false` because the Store attaches a process-global `:telemetry` handler;
  parallel scenes would cross-talk on the shared event bus.
  """

  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{Store, Scenes, SceneTelemetry}
  alias SpellAgent.Tui.Store.Span

  defp build(scene) do
    {:ok, store} = Store.start_link(name: nil)
    Store.attach(store)
    # Detach + stop without racing: Process.exit(:shutdown) is a clean, idempotent
    # teardown for an unlinked GenServer and never raises if it already exited.
    on_exit(fn -> if Process.alive?(store), do: Process.exit(store, :shutdown) end)

    SceneTelemetry.emit(scene, store: store)
    # By the time a synchronous call returns, every prior cast has been handled.
    _ = Store.spans(store)
    Store.spans(store)
  end

  for scene <- Scenes.all() do
    @scene scene

    describe "scene #{scene.name}" do
      test "reconstructs with the same node count and kinds as the fixture" do
        built = build(@scene)

        assert map_size(built) == map_size(@scene.forest),
               "telemetry rebuilt #{map_size(built)} spans, fixture has #{map_size(@scene.forest)}"

        fixture_kinds = @scene.forest |> Map.values() |> Enum.frequencies_by(& &1.kind)
        built_kinds = built |> Map.values() |> Enum.frequencies_by(& &1.kind)
        assert built_kinds == fixture_kinds
      end

      test "preserves the parent/child topology" do
        built = build(@scene)

        for {id, fixture_span} <- @scene.forest do
          built_span = Map.fetch!(built, id)
          assert built_span.parent_id == fixture_span.parent_id,
                 "parent of #{id} differs: built #{inspect(built_span.parent_id)} vs fixture #{inspect(fixture_span.parent_id)}"
        end

        # Every non-root's parent exists in the rebuilt forest (no orphans).
        for {_id, %Span{parent_id: pid}} <- built, pid != nil do
          assert Map.has_key?(built, pid), "orphaned span: parent #{pid} missing"
        end
      end

      test "propagates terminal status from stop events" do
        built = build(@scene)

        for {id, %Span{t1: t1, status: fixture_status}} <- @scene.forest, t1 != nil do
          assert Map.fetch!(built, id).status == fixture_status,
                 "status of #{id} differs after stop"
        end
      end

      test "folds run turns onto the owning run span" do
        built = build(@scene)

        for {id, %Span{kind: :run, turns: fixture_turns}} <- @scene.forest do
          built_turns = Map.fetch!(built, id).turns
          assert length(built_turns) == length(fixture_turns),
                 "run #{id} rebuilt #{length(built_turns)} turns, fixture has #{length(fixture_turns)}"
        end
      end
    end
  end

  test "an empty scene yields an empty forest (no phantom nodes)" do
    empty = Enum.find(Scenes.all(), &(&1.name == "empty"))
    assert build(empty) == %{}
  end
end