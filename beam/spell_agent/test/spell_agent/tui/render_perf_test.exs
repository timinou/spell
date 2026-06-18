defmodule SpellAgent.Tui.RenderPerfTest do
  @moduledoc """
  Performance budgets for the visual render path (PLAN-347), tagged `:perf` so
  they are opt-in: `mix test --only perf`.

  These guard the SAME `SceneRender` path the gallery, snapshots, and inspector
  use, so a regression that makes rendering slow is caught here rather than felt
  as a laggy TUI. Budgets are deliberately generous (≈10–30x the measured median
  on the dev machine the baselines were authored on: ~0.3 ms/scene render,
  sub-ms projection of a 500-node forest) so they fail only on a real
  order-of-magnitude regression, never on CI jitter.

  Measurement uses `:timer.tc` over a warmed loop and asserts on the MEDIAN, not a
  single sample, so a GC pause in one iteration can't flake the suite.
  """

  use ExUnit.Case, async: false

  @moduletag :perf

  alias SpellAgent.Tui.{Scenes, SceneRender, Store, Ui}
  alias SpellAgent.Tui.Panes.SpanTree

  # Median of N timed runs of `fun`, in milliseconds.
  defp median_ms(n, fun) do
    # Warm up so the first-call compile/alloc cost doesn't skew the median.
    for _ <- 1..5, do: fun.()

    times =
      for _ <- 1..n do
        {us, _} = :timer.tc(fun)
        us / 1000
      end

    sorted = Enum.sort(times)
    Enum.at(sorted, div(n, 2))
  end

  describe "scene render budget" do
    @scene_render_budget_ms 5.0

    for scene <- Scenes.all() do
      @scene scene

      test "rendering #{scene.name} to a headless buffer stays under budget" do
        median = median_ms(40, fn -> SceneRender.buffer(@scene, width: 80, height: 28) end)

        assert median < @scene_render_budget_ms,
               "scene #{@scene.name} render median #{median}ms exceeded #{@scene_render_budget_ms}ms budget"
      end
    end
  end

  describe "large-forest projection budget" do
    # Build a 500-node forest through the REAL telemetry → Store path (10 branch
    # runs × 50 tool children), so we measure the projection of a forest the
    # Store actually produces, not a hand-rolled map.
    defp large_forest do
      {:ok, store} = Store.start_link(name: nil)
      Store.attach(store)
      on_exit(fn -> if Process.alive?(store), do: Process.exit(store, :shutdown) end)

      emit = fn event, meta -> :telemetry.execute([:ptc_runner, :sub_agent] ++ event, %{}, meta) end
      emit.([:run, :start], %{span_id: "root", parent_span_id: nil, agent_name: "root"})

      for b <- 1..10 do
        bid = "b#{b}"
        emit.([:run, :start], %{span_id: bid, parent_span_id: "root", agent_name: "branch"})

        for c <- 1..50 do
          cid = "#{bid}_#{c}"
          emit.([:tool, :start], %{span_id: cid, parent_span_id: bid, tool_name: "t"})
          emit.([:tool, :stop], %{span_id: cid, status: :ok})
        end
      end

      _ = Store.spans(store)
      Store.spans(store)
    end

    @projection_budget_ms 10.0

    test "projecting a ~500-node forest stays under budget" do
      forest = large_forest()
      assert map_size(forest) >= 500

      gaze = Ui.new(focus: :tree, panes: [:tree], auto_depth: 1_000_000)

      # Sanity: the gaze is fully expanded, so every node becomes a row.
      assert SpanTree.project(forest, %{ui: gaze}).count >= 500

      median = median_ms(50, fn -> SpanTree.project(forest, %{ui: gaze}) end)

      assert median < @projection_budget_ms,
             "500-node projection median #{median}ms exceeded #{@projection_budget_ms}ms budget"
    end
  end
end