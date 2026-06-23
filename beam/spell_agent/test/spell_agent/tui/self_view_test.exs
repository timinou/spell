defmodule SpellAgent.Tui.SelfViewTest do
  @moduledoc """
  PLAN-016 W0 — the L−1 SEAM: the renderer reads its OWN output.

  The contract under test is the round-trip that makes the interface external
  working memory: a node authored over `data/forest` (the agent's live run-trace),
  rendered HEADLESS, returns an ASCII buffer that SHOWS the trace. No screen is
  painted; the forest is read from a live Store by the same `DataBag` projection
  the on-screen render uses.

  These pins defend the seam, not an implementation detail:
    * `live_bag/1` projects a live Store's forest into `data/forest` (+ summary).
    * `render/2` resolves a node's holes against that live bag and draws to ASCII.
    * the buffer contains data that ONLY the live forest could supply (proving the
      view reads the agent's own trace, not a static/empty env).
    * totality: an empty Store and a malformed node both degrade, never raise.
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp
  alias SpellAgent.Tui.{SelfView, Store}

  @telemetry_prefix [:ptc_runner, :sub_agent]

  setup do
    # An UNNAMED store so the test drives the seam in isolation (production uses
    # the global SpellAgent.Tui.Store; live_bag/1 takes :store for exactly this).
    {:ok, store} = Store.start_link(name: nil)
    :ok = Store.attach(store)
    %{store: store}
  end

  # Emit a real telemetry event the way PtcRunner.SubAgent.Telemetry does (the
  # actual forest-ingestion path the App relies on) — span ids live in metadata.
  defp emit(suffix, meta, meas \\ %{}) do
    :telemetry.execute(@telemetry_prefix ++ suffix, meas, meta)
  end

  # Seed a tiny trace: one run with a tool call whose label is distinctive, so a
  # rendered buffer containing it can ONLY have come from the live forest.
  defp seed_trace do
    emit([:run, :start], %{span_id: "run1", parent_span_id: nil, agent_name: "root"})
    emit([:tool, :start], %{span_id: "tool1", parent_span_id: "run1", tool_name: "SEEDED_TOOL"})

    emit([:tool, :stop], %{
      span_id: "tool1",
      parent_span_id: "run1",
      tool_name: "SEEDED_TOOL",
      result: %{}
    })
  end

  # A frozen tmpl:: node (the real layout producer) whose text is the space-joined
  # labels of every span in data/forest — a minimal trace board.
  defp forest_board do
    {:ok, step} =
      Lisp.run(
        ~S|(tmpl:: {:type "paragraph" :text ~(join " " (map (fn [s] (get s :label)) (vals data/forest)))})|
      )

    step.return
  end

  describe "live_bag/1 — the trace projected to data/*" do
    test "exposes the live forest read from the given store", %{store: store} do
      seed_trace()
      # Sanity: the store really has the spans before we project them.
      assert map_size(Store.spans(store)) > 0

      bag = SelfView.live_bag(store: store)

      forest = bag["forest"]
      assert is_map(forest)
      assert map_size(forest) == map_size(Store.spans(store))

      labels = forest |> Map.values() |> Enum.map(&Map.get(&1, "label"))
      assert Enum.any?(labels, &(&1 =~ "SEEDED_TOOL"))

      # The summary keys a self-view may also show are present + consistent.
      assert bag["forest-count"] == map_size(forest)
      assert bag["tools"] >= 1
    end

    test "an empty store degrades to an empty forest, never raises" do
      {:ok, empty} = Store.start_link(name: nil)
      :ok = Store.attach(empty)

      bag = SelfView.live_bag(store: empty)
      assert bag["forest"] == %{}
      assert bag["forest-count"] == 0
    end
  end

  describe "render/2 — the renderer reads its own output (the L−1 round-trip)" do
    test "renders a forest board over the LIVE trace to an ASCII buffer", %{store: store} do
      seed_trace()

      assert {:ok, %{buffer: buffer, width: 80, height: 24}} =
               SelfView.render(forest_board(), store: store)

      # The buffer SHOWS the live trace: a label that only the live forest holds.
      assert buffer =~ "SEEDED_TOOL"
    end

    test "the buffer reflects the forest at render time (live, not static)", %{store: store} do
      # Before any trace: the board renders empty (no labels to join).
      {:ok, %{buffer: before_buf}} = SelfView.render(forest_board(), store: store)
      refute before_buf =~ "SEEDED_TOOL"

      # After seeding: the SAME node now shows the new span — proving the view
      # reads the trace live, not a snapshot captured at author time.
      seed_trace()
      {:ok, %{buffer: after_buf}} = SelfView.render(forest_board(), store: store)
      assert after_buf =~ "SEEDED_TOOL"
    end

    test "honors custom dimensions", %{store: store} do
      seed_trace()

      assert {:ok, %{width: 50, height: 8}} =
               SelfView.render(forest_board(), store: store, width: 50, height: 8)
    end

    test "a pane-only node (needs live app state) reports empty, never crashes", %{store: store} do
      # A bare "pane" node cannot render standalone (RenderProbe contract) — the
      # seam surfaces that as an error tuple rather than raising.
      assert {:error, :empty_render} =
               SelfView.render(%{"type" => "pane", "slot" => "tree"}, store: store)
    end
  end
end
