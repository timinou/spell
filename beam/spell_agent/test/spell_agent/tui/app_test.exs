defmodule SpellAgent.Tui.AppTest do
  @moduledoc """
  Headless end-to-end test of the inspector TUI (PLAN-345 spike).

  Runs the real `ExRatatui.App` under `test_mode` (no TTY), injects keystrokes via
  `ExRatatui.Runtime.inject_event/2`, and drives a FAKE mission so the whole loop
  is exercised with zero network: type a prompt → Enter → a run executes →
  telemetry → Store forest → span_tree pane renders.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{App, Store}
  alias ExRatatui.Event.Key
  alias ExRatatui.Runtime

  setup do
    {:ok, store} = Store.start_link(name: nil)
    %{store: store}
  end

  defp key(code), do: %Key{code: code, kind: "press", modifiers: []}
  defp ctrl(code), do: %Key{code: code, kind: "press", modifiers: ["ctrl"]}

  # The App's callback map lives under the ExRatatui server's `:user_state`; read
  # it to assert navigation outcomes (PLAN-346 W2).
  defp app_state(pid), do: :sys.get_state(pid).user_state
  defp ui(pid), do: app_state(pid).ui

  defp type_string(pid, str) do
    for <<ch::utf8 <- str>>, do: :ok = Runtime.inject_event(pid, key(<<ch::utf8>>))
    :ok
  end

  # A fake "mission" that just emits a tiny span forest directly, so the App test
  # is independent of the agent loop (which the integration test already covers).
  defp fake_mission_emitting(_store) do
    fn _prompt ->
      :telemetry.execute([:ptc_runner, :sub_agent, :run, :start], %{}, %{
        span_id: "r",
        parent_span_id: nil,
        agent_name: "root"
      })

      :telemetry.execute([:ptc_runner, :sub_agent, :tool, :start], %{}, %{
        span_id: "t",
        parent_span_id: "r",
        tool_name: "find"
      })

      :telemetry.execute([:ptc_runner, :sub_agent, :tool, :stop], %{}, %{
        span_id: "t",
        parent_span_id: "r",
        tool_name: "find"
      })

      :telemetry.execute([:ptc_runner, :sub_agent, :run, :stop], %{}, %{span_id: "r", status: :ok})
      :done
    end
  end

  test "type a prompt, Enter runs the mission, the forest renders in the tree pane", %{store: store} do
    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        on_submit: fake_mission_emitting(store)
      )

    # The app subscribed + attached on mount; type and submit.
    :ok = type_string(pid, "hello")
    :ok = Runtime.inject_event(pid, key("enter"))

    # Give the Task + telemetry casts a beat to land, then sync the store.
    Process.sleep(50)
    spans = Store.spans(store)
    assert map_size(spans) == 2, "the mission's run + tool spans were captured"
    assert [%{id: "r", kind: :run}] = Store.run_spans(spans)

    # The app re-rendered after {:store_updated} broadcasts.
    snap = Runtime.snapshot(pid)
    assert snap.render_count >= 2

    GenServer.stop(pid)
  end

  test "backspace edits the composer buffer before submit", %{store: store} do
    {:ok, pid} =
      App.start_link(name: nil, test_mode: {80, 24}, store: store, on_submit: fn _ -> :noop end)

    :ok = type_string(pid, "abc")
    :ok = Runtime.inject_event(pid, key("backspace"))
    # No submit yet → no spans; buffer is "ab". Render must not crash.
    snap = Runtime.snapshot(pid)
    assert snap.render_count >= 1
    assert Store.spans(store) == %{}

    GenServer.stop(pid)
  end

  test "arrow keys move the tree cursor without crashing on an empty forest", %{store: store} do
    {:ok, pid} =
      App.start_link(name: nil, test_mode: {80, 24}, store: store, on_submit: fn _ -> :noop end)

    :ok = Runtime.inject_event(pid, key("down"))
    :ok = Runtime.inject_event(pid, key("up"))
    :ok = Runtime.inject_event(pid, key("down"))

    snap = Runtime.snapshot(pid)
    assert snap.render_count >= 1

    GenServer.stop(pid)
  end

  # ---- render-level tests for the header (D2: final answer; D3: status) ----

  alias ExRatatui.Frame

  alias SpellAgent.Tui.Ui

  # render/2 is a pure callback; build an explicit state to assert the panes.
  # PLAN-346: navigation lives in a %Ui{} gaze (was scattered focus/answer_scroll).
  defp state(overrides) do
    Map.merge(
      %{
        store: SpellAgent.Tui.Store,
        panes: [%{name: :tree, module: SpellAgent.Tui.Panes.SpanTree, assigns: %{}}],
        vms: %{tree: %{rows: [], count: 0}},
        composer: "",
        on_submit: fn _ -> :ok end,
        running?: false,
        result: nil,
        last_prompt: nil,
        ui: Ui.new(focus: :answer, panes: [:answer, :tree, :prompt])
      },
      overrides
    )
  end

  # Render order: [status, answer, tree…, composer]. Pull each Paragraph's text.
  defp paragraph_text({%ExRatatui.Widgets.Paragraph{text: t}, _rect}), do: t
  defp status_text(widgets), do: paragraph_text(Enum.at(widgets, 0))
  defp answer_text(widgets), do: paragraph_text(Enum.at(widgets, 1))
  defp composer_text(widgets), do: paragraph_text(List.last(widgets))

  test "the composer hint is DERIVED from the live keymap, focus-aware (W4)", %{store: store} do
    tree = state(%{store: store, ui: Ui.new(focus: :tree, panes: [:answer, :tree, :prompt])})
    tree_hint = composer_text(App.render(tree, %Frame{width: 100, height: 24}))
    # Under tree focus the hint shows the span verbs' ACTUAL chords + globals.
    assert tree_hint =~ "C-l expand"
    assert tree_hint =~ "C-h collapse"
    assert tree_hint =~ "C-j pane"
    assert tree_hint =~ "quit"

    answer = state(%{store: store, ui: Ui.new(focus: :answer, panes: [:answer, :tree, :prompt])})
    answer_hint = composer_text(App.render(answer, %Frame{width: 100, height: 24}))
    # Under answer focus the SAME C-l now reads as turn navigation.
    assert answer_hint =~ "C-l next turn"
  end

  test "D2: the full final answer is shown in the scrollable answer pane", %{store: store} do
    long = String.duplicate("word ", 200) <> "END"
    widgets = App.render(state(%{store: store, result: {:ok, long}}), %Frame{width: 80, height: 24})

    # The answer pane carries the WHOLE answer untruncated (it scrolls to show all).
    assert answer_text(widgets) =~ "END"
    assert String.length(answer_text(widgets)) >= String.length(long)
    # Status line summarizes the outcome separately.
    assert status_text(widgets) =~ "done"
  end

  test "D2: an error result is surfaced in the answer pane and status", %{store: store} do
    widgets =
      App.render(state(%{store: store, result: {:error, :boom}}), %Frame{width: 80, height: 24})

    assert answer_text(widgets) =~ "error"
    assert answer_text(widgets) =~ "boom"
    assert status_text(widgets) =~ "✗"
  end

  test "D3: the status line shows running while a mission is in flight", %{store: store} do
    widgets = App.render(state(%{store: store, running?: true}), %Frame{width: 80, height: 24})
    assert status_text(widgets) =~ "running"
  end

  test "answer pane scroll offset reflects the gaze (scrollable)", %{store: store} do
    ui = Ui.new(focus: :answer, panes: [:answer, :tree, :prompt]) |> Ui.scroll(:answer, +7)

    {%ExRatatui.Widgets.Paragraph{scroll: scroll}, _} =
      Enum.at(
        App.render(state(%{store: store, result: {:ok, "x"}, ui: ui}), %Frame{width: 80, height: 24}),
        1
      )

    assert scroll == {7, 0}
  end

  # ---- W2: the Reaction DSL chords, end to end through the App ----

  # Emit a small forest straight into a store (root run "r" with a child tool "t")
  # so the tree pane has rows to navigate without running a mission.
  defp seed_forest(store) do
    h = "spell-tui-app-test-#{:erlang.unique_integer([:positive])}"
    events =
      for kind <- [:run, :tool], phase <- [:start, :stop] do
        [:ptc_runner, :sub_agent, kind, phase]
      end

    :ok = :telemetry.attach_many(h, events, &SpellAgent.Tui.Store.handle_telemetry/4, %{pid: store})
    :telemetry.execute([:ptc_runner, :sub_agent, :run, :start], %{}, %{span_id: "r", parent_span_id: nil, agent_name: "root"})
    :telemetry.execute([:ptc_runner, :sub_agent, :tool, :start], %{}, %{span_id: "t", parent_span_id: "r", tool_name: "find"})
    :telemetry.execute([:ptc_runner, :sub_agent, :tool, :stop], %{}, %{span_id: "t", parent_span_id: "r", tool_name: "find"})
    :telemetry.execute([:ptc_runner, :sub_agent, :run, :stop], %{}, %{span_id: "r", status: :ok})
    :telemetry.detach(h)
    # let the casts land
    _ = SpellAgent.Tui.Store.spans(store)
    :ok
  end

  describe "intent-based navigation chords (PLAN-346 W2)" do
    setup %{store: store} do
      SpellAgent.Tui.KeymapRegistry.reset()
      :ok = seed_forest(store)

      {:ok, pid} =
        App.start_link(name: nil, test_mode: {80, 24}, store: store, on_submit: fn _ -> :noop end)

      %{pid: pid}
    end

    test "ctrl-j / ctrl-k move focus around the pane ring", %{pid: pid} do
      # default focus is :answer; ring is [answer, tree, prompt].
      assert ui(pid).focus == :answer
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :tree
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :prompt
      # wrap, then back
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :answer
      :ok = Runtime.inject_event(pid, ctrl("k"))
      assert ui(pid).focus == :prompt
    end

    test "the SAME chord (ctrl-l/ctrl-h) means expand under tree focus, turn-nav under answer focus", %{pid: pid} do
      # Under ANSWER focus, ctrl-l navigates turns.
      assert ui(pid).focus == :answer
      :ok = Runtime.inject_event(pid, ctrl("l"))
      assert ui(pid).turn == 1
      :ok = Runtime.inject_event(pid, ctrl("h"))
      assert ui(pid).turn == 0
      refute Map.has_key?(ui(pid).overrides, "r"), "answer focus did not touch span collapse"

      # Focus the tree; now ctrl-l/ctrl-h expand/collapse the span under the cursor.
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :tree
      # cursor at row 0 = the root run "r". ctrl-h collapses it, ctrl-l expands it.
      :ok = Runtime.inject_event(pid, ctrl("h"))
      assert ui(pid).overrides["r"] == :collapsed
      assert ui(pid).turn == 0, "tree focus did not touch the turn index"
      :ok = Runtime.inject_event(pid, ctrl("l"))
      assert ui(pid).overrides["r"] == :expanded
    end

    test "arrows move the tree cursor under tree focus", %{pid: pid} do
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :tree
      :ok = Runtime.inject_event(pid, key("down"))
      assert SpellAgent.Tui.Ui.cursor_of(ui(pid), :tree) == 1
      :ok = Runtime.inject_event(pid, key("up"))
      assert SpellAgent.Tui.Ui.cursor_of(ui(pid), :tree) == 0
    end

    test "a live keymap/bind rebind shadows the compiled chord (AXIS 2)", %{pid: pid} do
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :tree
      # rebind ctrl-l in the tree context to CONTRACT instead of expand.
      SpellAgent.Tui.KeymapRegistry.bind(:tree, SpellAgent.Tui.Chord.parse("C-l"), :"span/contract")
      :ok = Runtime.inject_event(pid, ctrl("l"))
      assert ui(pid).overrides["r"] == :collapsed, "rebound chord fired the contract reaction"
    end

    test "an unbound printable falls through to the composer", %{pid: pid} do
      :ok = type_string(pid, "hi")
      assert app_state(pid).composer == "hi"
    end

    test "a shifted printable (uppercase / shifted punct) still types into the composer", %{pid: pid} do
      # crossterm folds shift into the code: "H" arrives as code "H" with [:shift].
      :ok = Runtime.inject_event(pid, %Key{code: "H", kind: "press", modifiers: ["shift"]})
      :ok = Runtime.inject_event(pid, %Key{code: "i", kind: "press", modifiers: []})
      :ok = Runtime.inject_event(pid, %Key{code: "!", kind: "press", modifiers: ["shift"]})
      assert app_state(pid).composer == "Hi!"
    end

    test "a ctrl-printable that is unbound does NOT leak into the composer", %{pid: pid} do
      # ctrl+z is bound nowhere; it must be dropped, not inserted as a glyph.
      :ok = Runtime.inject_event(pid, ctrl("z"))
      assert app_state(pid).composer == ""
    end

    test "esc quits (stops the app)", %{pid: pid} do
      ref = Process.monitor(pid)
      :ok = Runtime.inject_event(pid, key("esc"))
      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 1000
    end
  end

  test "D2: a completed run via the live app lands its result in the answer pane", %{store: store} do
    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        on_submit: fn _ -> {:ok, "the-answer-7"} end
      )

    :ok = type_string(pid, "q")
    :ok = Runtime.inject_event(pid, key("enter"))
    Process.sleep(50)

    # The app re-rendered after the Task result landed; render count advanced.
    snap = Runtime.snapshot(pid)
    assert snap.render_count >= 2

    GenServer.stop(pid)
  end
end
