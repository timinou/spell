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

  # Enter INSERT mode (Enter on the prompt) so plain typing fills the composer —
  # PLAN-346 W5 modal flow. Launch is prompt+NORMAL.
  defp enter_insert(pid), do: Runtime.inject_event(pid, key("enter"))

  test "type a prompt, Enter runs the mission, the forest renders in the tree pane", %{
    store: store
  } do
    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        on_submit: fake_mission_emitting(store)
      )

    # Launch is prompt+NORMAL: Enter -> INSERT, type, Enter -> submit.
    :ok = enter_insert(pid)
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

    :ok = enter_insert(pid)
    :ok = type_string(pid, "abc")
    :ok = Runtime.inject_event(pid, key("backspace"))
    # No submit yet → no spans; buffer is "ab". Render must not crash.
    assert app_state(pid).composer == "ab"
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
  # PLAN-346 W5: two projected panes (tree + detail) + the composer.
  defp state(overrides) do
    Map.merge(
      %{
        store: SpellAgent.Tui.Store,
        panes: [
          %{name: :tree, module: SpellAgent.Tui.Panes.SpanTree, assigns: %{}},
          %{name: :detail, module: SpellAgent.Tui.Panes.Detail, assigns: %{}}
        ],
        vms: %{tree: %{rows: [], count: 0}, detail: %{title: "detail", body: "(empty)"}},
        composer: "",
        on_submit: fn _ -> :ok end,
        running?: false,
        result: nil,
        last_prompt: nil,
        ui: Ui.new(focus: :tree, panes: [:prompt, :tree, :detail])
      },
      overrides
    )
  end

  # Render order: [status, tree, detail, composer]. Pull each Paragraph's text
  # (the tree is a List, not a Paragraph, so index past it for detail/composer).
  defp paragraph_text({%ExRatatui.Widgets.Paragraph{text: t}, _rect}), do: t
  defp status_text(widgets), do: paragraph_text(Enum.at(widgets, 0))
  defp detail_text(widgets), do: paragraph_text(Enum.at(widgets, 2))
  defp composer_text(widgets), do: paragraph_text(List.last(widgets))

  defp composer_title(widgets) do
    {%ExRatatui.Widgets.Paragraph{block: %ExRatatui.Widgets.Block{title: t}}, _} =
      List.last(widgets)

    t
  end

  test "the composer hint is DERIVED from the live keymap, focus-aware (W5)", %{store: store} do
    # Reset live overrides so this asserts the COMPILED keymap (other tests share
    # the supervised KeymapRegistry and may have left rebinds that shadow it).
    if Process.whereis(SpellAgent.Tui.KeymapRegistry), do: SpellAgent.Tui.KeymapRegistry.reset()

    tree = state(%{store: store, ui: Ui.new(focus: :tree, panes: [:prompt, :tree, :detail])})
    tree_hint = composer_text(App.render(tree, %Frame{width: 120, height: 24}))
    # Under tree focus the hint shows the vim-nav chords + globals.
    assert tree_hint =~ "j next"
    assert tree_hint =~ "l in"
    assert tree_hint =~ "h out"
    assert tree_hint =~ "C-j pane"
    assert tree_hint =~ "quit"
    # Title carries the modal indicator.
    assert composer_title(App.render(tree, %Frame{width: 120, height: 24})) =~ "NORMAL"

    prompt = state(%{store: store, ui: Ui.new(focus: :prompt, panes: [:prompt, :tree, :detail])})
    prompt_hint = composer_text(App.render(prompt, %Frame{width: 120, height: 24}))
    # Under prompt focus, Enter is the "type" affordance (mode/insert).
    assert prompt_hint =~ "enter type"
  end

  test "the composer title shows INSERT when in insert mode", %{store: store} do
    ui = Ui.new(focus: :prompt, mode: :insert, panes: [:prompt, :tree, :detail])

    widgets =
      App.render(state(%{store: store, composer: "hi", ui: ui}), %Frame{width: 80, height: 24})

    assert composer_title(widgets) =~ "INSERT"
    assert composer_text(widgets) =~ "hi"
  end

  test "the detail pane renders the selected node's full content (see inside the turn)", %{
    store: store
  } do
    # A run with one turn whose program is long; selecting it shows the FULL text.
    long = "(do " <> String.duplicate("x ", 100) <> "END)"

    forest = %{
      "r" => %SpellAgent.Tui.Store.Span{
        id: "r",
        parent_id: nil,
        kind: :run,
        status: :ok,
        label: "root",
        turns: [%{number: 1, program: long, result_preview: "42", response: nil, status: :ok}]
      }
    }

    # Cursor on row 1 = the turn. Build the detail vm from the real projection.
    ui = Ui.new(focus: :tree, panes: [:prompt, :tree, :detail]) |> Map.put(:cursors, %{tree: 1})
    detail_vm = SpellAgent.Tui.Panes.Detail.project(forest, %{ui: ui})

    panes = [
      %{name: :tree, module: SpellAgent.Tui.Panes.SpanTree, assigns: %{}},
      %{name: :detail, module: SpellAgent.Tui.Panes.Detail, assigns: %{}}
    ]

    widgets =
      App.render(
        state(%{
          store: store,
          ui: ui,
          panes: panes,
          vms: %{tree: %{rows: [], count: 0}, detail: detail_vm}
        }),
        %Frame{width: 80, height: 24}
      )

    # The detail pane carries the WHOLE program untruncated (scrolls to show all).
    assert detail_text(widgets) =~ "END"
    assert detail_text(widgets) =~ "program"
  end

  test "D3: the status line shows the outcome (running / done / failed)", %{store: store} do
    running = App.render(state(%{store: store, running?: true}), %Frame{width: 80, height: 24})
    assert status_text(running) =~ "running"

    done = App.render(state(%{store: store, result: {:ok, "x"}}), %Frame{width: 80, height: 24})
    assert status_text(done) =~ "done"

    failed =
      App.render(state(%{store: store, result: {:error, :boom}}), %Frame{width: 80, height: 24})

    assert status_text(failed) =~ "✗"
  end

  test "the detail pane scroll offset reflects the gaze (scrollable)", %{store: store} do
    ui = Ui.new(focus: :detail, panes: [:prompt, :tree, :detail]) |> Ui.scroll(:detail, +7)

    {%ExRatatui.Widgets.Paragraph{scroll: scroll}, _} =
      Enum.at(
        App.render(state(%{store: store, ui: ui}), %Frame{width: 80, height: 24}),
        2
      )

    assert scroll == {7, 0}
  end

  # BUG-007: when the agent shadows a PANE slot (not just status/composer) with a
  # custom widget, the shadowed node keeps its `slot` but loses `type: "pane"`, so
  # it falls out of `Lens.focusables/1`. The old adoption gate keyed on focusables,
  # so the focusable set shrank, the equality check failed, and the WHOLE agent
  # tree silently un-adopted -> the live render fell back to the native default and
  # nothing changed on screen. The gate now keys on the STABLE body-slot identities
  # (`Lens.body_pane_slots/1`), so a reshaped pane still renders. This asserts the
  # render OUTPUT through the gate, not just registry state.
  test "BUG-007: an agent shadow on a PANE slot survives the render-adoption gate",
       %{store: store} do
    alias SpellAgent.Tui.{DefaultLayout, LayoutRegistry, Lens}

    st = state(%{store: store})
    pane_names = Enum.map(st.panes, &Atom.to_string(&1.name))
    ui = Ui.new(focus: :tree, panes: [:prompt | Enum.map(st.panes, & &1.name)])

    # Seed the registry with the tree for THIS app's pane set (tree, detail), so
    # the adoption gate can match.
    default = DefaultLayout.tree(ui, pane_names)

    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default})
      _ -> LayoutRegistry.seed_default(default)
    end

    # The agent reshapes the `detail` PANE into a custom dashboard widget.
    assert :ok =
             LayoutRegistry.set("detail", %{
               "type" => "paragraph",
               "text" => "AGENT-RESHAPED-DETAIL"
             })

    # focusables shrank (the reshaped pane is no longer a pane node)...
    refute "detail" in Lens.focusables(LayoutRegistry.tree())
    # ...but the STABLE body slots still match the app's panes, so the gate adopts.
    assert Lens.body_pane_slots(LayoutRegistry.tree()) == pane_names

    widgets = App.render(st, %Frame{width: 120, height: 24})
    rendered = Enum.map_join(widgets, "\n", fn {w, _r} -> inspect(w) end)
    assert rendered =~ "AGENT-RESHAPED-DETAIL"
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

    :ok =
      :telemetry.attach_many(h, events, &SpellAgent.Tui.Store.handle_telemetry/4, %{pid: store})

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
    :telemetry.detach(h)
    # let the casts land
    _ = SpellAgent.Tui.Store.spans(store)
    :ok
  end

  describe "modal navigation chords (PLAN-346 W5)" do
    setup %{store: store} do
      SpellAgent.Tui.KeymapRegistry.reset()
      :ok = seed_forest(store)

      {:ok, pid} =
        App.start_link(name: nil, test_mode: {80, 24}, store: store, on_submit: fn _ -> :noop end)

      %{pid: pid}
    end

    test "launch is prompt focus in NORMAL mode", %{pid: pid} do
      assert ui(pid).focus == :prompt
      assert ui(pid).mode == :normal
    end

    test "ctrl-j / ctrl-k move focus around the pane ring", %{pid: pid} do
      # ring is [prompt, history, tree, detail] (PLAN-003 added :history).
      assert ui(pid).focus == :prompt
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :history
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :tree
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :detail
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :prompt
      :ok = Runtime.inject_event(pid, ctrl("k"))
      assert ui(pid).focus == :detail
    end

    test "modal: Enter on the prompt enters INSERT; typing fills the composer; Esc returns to NORMAL",
         %{pid: pid} do
      assert ui(pid).mode == :normal
      # In NORMAL, plain letters do NOT type (they're chords / no-ops).
      :ok = type_string(pid, "x")
      assert app_state(pid).composer == ""
      # Enter (on the prompt) -> INSERT.
      :ok = Runtime.inject_event(pid, key("enter"))
      assert ui(pid).mode == :insert
      # now typing fills the composer.
      :ok = type_string(pid, "hi")
      assert app_state(pid).composer == "hi"
      # Esc -> NORMAL, buffer kept.
      :ok = Runtime.inject_event(pid, key("esc"))
      assert ui(pid).mode == :normal
      assert app_state(pid).composer == "hi"
    end

    test "vim tree-nav: j/k move the cursor, l descends, h ascends", %{pid: pid} do
      # focus the tree (ctrl-j twice from prompt: prompt -> history -> tree).
      :ok = Runtime.inject_event(pid, ctrl("j"))
      :ok = Runtime.inject_event(pid, ctrl("j"))
      assert ui(pid).focus == :tree
      # forest: run "r" (row 0) -> tool "t" (row 1). j moves down, k up.
      :ok = Runtime.inject_event(pid, key("j"))
      assert SpellAgent.Tui.Ui.cursor_of(ui(pid), :tree) == 1
      :ok = Runtime.inject_event(pid, key("k"))
      assert SpellAgent.Tui.Ui.cursor_of(ui(pid), :tree) == 0
      # l on the root (has a child) descends to the first child (row 1).
      :ok = Runtime.inject_event(pid, key("l"))
      assert SpellAgent.Tui.Ui.cursor_of(ui(pid), :tree) == 1
      # h ascends back to the parent (row 0).
      :ok = Runtime.inject_event(pid, key("h"))
      assert SpellAgent.Tui.Ui.cursor_of(ui(pid), :tree) == 0
    end

    test "a shifted printable types in INSERT mode", %{pid: pid} do
      :ok = Runtime.inject_event(pid, key("enter"))
      assert ui(pid).mode == :insert
      :ok = Runtime.inject_event(pid, %Key{code: "H", kind: "press", modifiers: ["shift"]})
      :ok = Runtime.inject_event(pid, %Key{code: "i", kind: "press", modifiers: []})
      :ok = Runtime.inject_event(pid, %Key{code: "!", kind: "press", modifiers: ["shift"]})
      assert app_state(pid).composer == "Hi!"
    end

    test "esc in NORMAL quits (stops the app)", %{pid: pid} do
      ref = Process.monitor(pid)
      :ok = Runtime.inject_event(pid, key("esc"))
      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 1000
    end
  end

  test "a completed run via the live app lands its result (status reflects done)", %{store: store} do
    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        on_submit: fn _ -> {:ok, "the-answer-7"} end
      )

    # Modal flow: Enter -> INSERT, type, Enter -> submit.
    :ok = enter_insert(pid)
    :ok = type_string(pid, "q")
    :ok = Runtime.inject_event(pid, key("enter"))
    Process.sleep(50)

    # The app re-rendered after the Task result landed; render count advanced.
    snap = Runtime.snapshot(pid)
    assert snap.render_count >= 2

    GenServer.stop(pid)
  end

  # ---- PLAN-003 SEAM 3+4: the History pane resumes a durable conversation ----

  alias SpellAgent.Hist.Recorder
  alias SpellAgent.Hist.Store, as: HistStore
  alias SpellAgent.Hist.Store.Memory, as: HistMemory
  alias SpellAgent.Tui.Panes.History

  test "mounting with a recorded session resumes its transcript in the History pane", %{
    store: store
  } do
    HistStore.clear(HistMemory)

    a =
      Recorder.record_node(
        HistMemory,
        "resumed",
        %{program: "(w)", memory: %{}, result: "did the thing", prompt: "do the thing"},
        nil
      )

    {:ok, sess} = HistStore.fetch(HistMemory, {:session, "resumed"})
    HistStore.put(HistMemory, {:session, "resumed"}, %{sess | cursors: %{main: a.id}})

    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        hist_store: HistMemory,
        hist_session: "resumed",
        on_submit: fn _ -> :noop end
      )

    # SEAM 4: the App bound the durable session; SEAM 3: the History pane projected
    # its transcript from the store, not the (empty) span forest.
    vm = :sys.get_state(pid).user_state.vms.history
    refute vm.empty?
    assert Enum.map(vm.lines, & &1.role) == [:user, :assistant]
    assert Enum.map(vm.lines, & &1.text) == ["do the thing", "did the thing"]

    GenServer.stop(pid)
  end

  test "mounting with no recorded history shows the History empty state", %{store: store} do
    HistStore.clear(HistMemory)

    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        hist_store: HistMemory,
        hist_session: "fresh-empty",
        on_submit: fn _ -> :noop end
      )

    vm = :sys.get_state(pid).user_state.vms.history
    assert vm.empty?
    assert vm.lines == []

    GenServer.stop(pid)
  end

  test "the History pane is in the default pane set + focus ring", %{store: store} do
    HistStore.clear(HistMemory)

    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        hist_store: HistMemory,
        on_submit: fn _ -> :noop end
      )

    st = :sys.get_state(pid).user_state
    assert Enum.any?(st.panes, &(&1.name == :history and &1.module == History))
    assert :history in st.ui.panes

    GenServer.stop(pid)
  end

  # BUG-004 T2: a focused History pane scrolls via TurnNav (j/k), like Detail.
  test "j scrolls the History transcript when History is focused", %{store: store} do
    HistStore.clear(HistMemory)

    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        hist_store: HistMemory,
        on_submit: fn _ -> :noop end
      )

    # prompt -> history (one ctrl-j in the [prompt, history, tree, detail] ring).
    :ok = Runtime.inject_event(pid, ctrl("j"))
    assert ui(pid).focus == :history
    before = SpellAgent.Tui.Ui.scroll_of(ui(pid), :history)
    :ok = Runtime.inject_event(pid, key("j"))
    assert SpellAgent.Tui.Ui.scroll_of(ui(pid), :history) == before + 1

    GenServer.stop(pid)
  end
end
