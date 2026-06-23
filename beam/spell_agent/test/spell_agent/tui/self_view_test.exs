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
  alias SpellAgent.Tui.SelfView.Idioms

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

    test "the SAME pre-authored node reflects the forest at render time (live, not static)",
         %{store: store} do
      # Author the node ONCE, BEFORE any trace exists. If the layout path snapshots
      # data/forest at author time, the post-seed render would still be empty — so
      # re-authoring after seeding would mask that bug. Binding one node and
      # rendering it twice is the honest proof of RENDER-time liveness.
      board = forest_board()

      {:ok, %{buffer: before_buf}} = SelfView.render(board, store: store)
      refute before_buf =~ "SEEDED_TOOL"

      seed_trace()
      {:ok, %{buffer: after_buf}} = SelfView.render(board, store: store)
      assert after_buf =~ "SEEDED_TOOL"
    end

    test "honors custom dimensions", %{store: store} do
      seed_trace()

      assert {:ok, %{width: 50, height: 8}} =
               SelfView.render(forest_board(), store: store, width: 50, height: 8)
    end

    test "data/area tracks the render dimensions (a view sees the frame it draws on)",
         %{store: store} do
      # A self-view that branches on its own size must observe the SAME frame it is
      # drawn into. render/2 derives data/area from the render dims, so a 50-wide
      # render reports width 50 to the view — not the 80×24 default.
      {:ok, step} =
        Lisp.run(~S|(tmpl:: {:type "paragraph" :text ~(str "W" (get data/area :width))})|)

      node = step.return

      {:ok, %{buffer: sized}} = SelfView.render(node, store: store, width: 50, height: 8)
      assert sized =~ "W50"

      {:ok, %{buffer: default}} = SelfView.render(node, store: store)
      assert default =~ "W80"
    end

    test "a pane-only node (needs live app state) reports empty, never crashes", %{store: store} do
      # A bare "pane" node cannot render standalone (RenderProbe contract) — the
      # seam surfaces that as an error tuple rather than raising.
      assert {:error, :empty_render} =
               SelfView.render(%{"type" => "pane", "slot" => "tree"}, store: store)
    end

    test "a node that raises at draw time is caught, never crashes the caller", %{store: store} do
      # The totality claim covers malformed widgets, not just empty renders: a
      # sparkline over non-numeric data materializes but raises inside ExRatatui's
      # draw. The seam must return an error tuple, not propagate the raise into the
      # mission process (a self-view can never take the agent down).
      node = %{"type" => "sparkline", "data" => ["not", "numbers"]}
      assert {:error, {:render_failed, _message}} = SelfView.render(node, store: store)
    end
  end

  describe "the production seam — the default global Store, no :store injected" do
    # The mission tool that calls a self-view runs in a process that cannot capture
    # an App pid; it reaches the forest by GLOBAL NAME (SpellAgent.Tui.Store). Every
    # other test injects :store, so this is the ONE test that defends the actual
    # production path: seed the NAMED global Store and render with no :store at all.
    setup do
      # The global Store is supervised app-wide; ensure it is attached + clean so
      # this test's seeded trace is the only forest it sees.
      :ok = Store.attach(Store)
      Store.reset(Store)
      on_exit(fn -> Store.reset(Store) end)
      :ok
    end

    test "render/2 with no :store reads the global Store and shows its live trace" do
      # Seed the NAMED store (default args -> SpellAgent.Tui.Store).
      emit([:run, :start], %{span_id: "grun", parent_span_id: nil, agent_name: "root"})

      emit([:tool, :start], %{
        span_id: "gtool",
        parent_span_id: "grun",
        tool_name: "GLOBAL_SEEDED"
      })

      emit([:tool, :stop], %{
        span_id: "gtool",
        parent_span_id: "grun",
        tool_name: "GLOBAL_SEEDED",
        result: %{}
      })

      # Force the cast to drain before asserting (a call to the same GenServer).
      assert map_size(Store.spans(Store)) > 0

      assert {:ok, %{buffer: buffer}} = SelfView.render(forest_board())
      assert buffer =~ "GLOBAL_SEEDED"
    end
  end

  describe "view/think tool — the L−1 primitive on the freeform surface" do
    # The tool reaches the forest by GLOBAL NAME (a mission tool cannot inject a
    # store), so these drive the named global Store exactly like a real call.
    setup do
      :ok = Store.attach(Store)
      Store.reset(Store)
      on_exit(fn -> Store.reset(Store) end)
      %{think: SelfView.tools()["view/think"]}
    end

    defp seed_global do
      emit([:run, :start], %{span_id: "trun", parent_span_id: nil, agent_name: "root"})

      emit([:tool, :start], %{span_id: "ttool", parent_span_id: "trun", tool_name: "THINK_SEEDED"})

      emit([:tool, :stop], %{
        span_id: "ttool",
        parent_span_id: "trun",
        tool_name: "THINK_SEEDED",
        result: %{}
      })

      assert map_size(Store.spans(Store)) > 0
    end

    test "renders an authored node over the live trace, returning a string-keyed buffer",
         %{think: think} do
      seed_global()

      board =
        forest_board_src()

      result = think.(%{"source" => board})
      assert %{"buffer" => buffer, "width" => 80, "height" => 24} = result
      assert buffer =~ "THINK_SEEDED"
    end

    test "accepts :node as an alias for :source", %{think: think} do
      seed_global()
      assert %{"buffer" => buffer} = think.(%{"node" => forest_board_src()})
      assert buffer =~ "THINK_SEEDED"
    end

    test "honors :width/:height and the buffer's data/area tracks them", %{think: think} do
      {:ok, step} =
        Lisp.run(~S|(tmpl:: {:type "paragraph" :text ~(str "W" (get data/area :width))})|)

      assert %{"buffer" => buffer, "width" => 50, "height" => 8} =
               think.(%{"source" => step.return, "width" => 50, "height" => 8})

      assert buffer =~ "W50"
    end

    test "a missing :source returns an %{err} map, not a crash", %{think: think} do
      assert %{"err" => msg} = think.(%{})
      assert msg =~ "source"
    end

    test "a pane-only node returns an %{err} explaining it needs the live app", %{think: think} do
      assert %{"err" => msg} = think.(%{"source" => %{"type" => "pane", "slot" => "tree"}})
      assert msg =~ "pane" or msg =~ "renderable"
    end

    test "a draw-time raise returns an %{err}, never propagating", %{think: think} do
      node = %{"type" => "sparkline", "data" => ["not", "numbers"]}
      assert %{"err" => msg} = think.(%{"source" => node})
      assert is_binary(msg)
    end

    test "view/think is registered on the freeform tool surface" do
      # The L−1 primitive must actually be reachable by name from the agent's
      # tool map, not merely defined — a registration regression would silently
      # remove the affordance.
      assert Map.has_key?(SpellAgent.Tools.build_tools_map(), "view/think")
    end

    test "the REGISTERED callable renders the live trace and never mutates the forest" do
      # Exercise the tool exactly as the agent reaches it — by name from the live
      # tool map — and pin the load-bearing capability claim: a self-view only ever
      # LOOKS. Rendering must leave the forest byte-identical (read-only).
      seed_global()
      before = Store.spans(Store)

      think = SpellAgent.Tools.build_tools_map()["view/think"]
      assert %{"buffer" => buffer} = think.(%{"source" => forest_board_src()})
      assert buffer =~ "THINK_SEEDED"

      assert Store.spans(Store) == before
    end
  end

  describe "trace idioms — the named projections worth rendering (W2)" do
    setup do
      :ok = Store.attach(Store)
      Store.reset(Store)
      on_exit(fn -> Store.reset(Store) end)
      %{think: SelfView.tools()["view/think"]}
    end

    # A trace with ONE errored tool (reason BOOM) and one ok tool, so a projection
    # that filters errors can be distinguished from one that shows everything.
    defp seed_mixed do
      emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "root"})
      emit([:tool, :start], %{span_id: "bad", parent_span_id: "r", tool_name: "edit"})

      emit([:tool, :exception], %{
        span_id: "bad",
        parent_span_id: "r",
        tool_name: "edit",
        kind: :error,
        reason: "BOOM_REASON"
      })

      emit([:tool, :start], %{span_id: "good", parent_span_id: "r", tool_name: "find"})

      emit([:tool, :stop], %{span_id: "good", parent_span_id: "r", tool_name: "find", result: %{}})

      assert map_size(Store.spans(Store)) > 0
    end

    test "errors-board shows ONLY errored spans, with their reason", %{think: think} do
      seed_mixed()
      assert %{"buffer" => buffer} = think.(%{"name" => "errors-board"})
      # The errored tool + its reason appear …
      assert buffer =~ "edit"
      assert buffer =~ "BOOM_REASON"
      # … and the OK tool does NOT (the whole point of an errors projection).
      refute buffer =~ "find"
    end

    test "tool-calls shows every tool span with its status", %{think: think} do
      seed_mixed()
      assert %{"buffer" => buffer} = think.(%{"name" => "tool-calls"})
      assert buffer =~ "edit"
      assert buffer =~ "find"
      assert buffer =~ "error"
    end

    test "trace-summary's counts are derived from the LIVE forest, not hardcoded",
         %{think: think} do
      # Render over an EMPTY forest first: zero tools, zero errors.
      assert %{"buffer" => empty} = think.(%{"name" => "trace-summary"})
      assert empty =~ "tools 0"
      assert empty =~ "errors 0"

      # Then over a mixed forest (1 error + 1 ok tool): the tally MUST move with the
      # trace — a projection that ignored data/forest and hardcoded a suffix could
      # not pass both states.
      seed_mixed()
      assert %{"buffer" => mixed} = think.(%{"name" => "trace-summary"})
      assert mixed =~ "tools 2"
      assert mixed =~ "errors 1"
    end

    test "an idiom renders a valid EMPTY board over an empty trace (no crash)", %{think: think} do
      # No seed: the forest is empty. A filter-based idiom must still render the
      # board STRUCTURE (its titled frame), not merely 'some string' — is_binary
      # alone would pass a blank buffer or even the wrong idiom.
      assert %{"buffer" => buffer} = think.(%{"name" => "errors-board"})
      assert buffer =~ "errors"
      refute buffer =~ "BOOM_REASON"
    end

    test "an unknown idiom name returns an %{err} listing the available ones", %{think: think} do
      assert %{"err" => msg} = think.(%{"name" => "no-such-idiom"})
      assert msg =~ "errors-board"
      assert msg =~ "unknown"
    end

    test ":name wins over :source when both are given", %{think: think} do
      seed_mixed()
      # A :source that would render TANGENT_LABEL, plus :name errors-board: the
      # NAMED idiom must win, so the buffer shows the error reason, not the tangent.
      {:ok, step} = Lisp.run(~S|(tmpl:: {:type "paragraph" :text "TANGENT_LABEL"})|)

      assert %{"buffer" => buffer} =
               think.(%{"name" => "errors-board", "source" => step.return})

      assert buffer =~ "BOOM_REASON"
      refute buffer =~ "TANGENT_LABEL"
    end

    test "Idioms.names/0 lists exactly the compiled idioms" do
      # Every declared template must compile to a frozen node — a typo in a tmpl::
      # source would silently drop the idiom (the @frozen reject), so pin the set.
      assert Idioms.names() == ["errors-board", "tool-calls", "trace-summary"]
      for name <- Idioms.names(), do: assert(is_map(Idioms.node(name)))
    end
  end

  # The forest board as a frozen tmpl:: node (re-usable across describe blocks).
  defp forest_board_src do
    {:ok, step} =
      Lisp.run(
        ~S|(tmpl:: {:type "paragraph" :text ~(join " " (map (fn [s] (get s :label)) (vals data/forest)))})|
      )

    step.return
  end
end
