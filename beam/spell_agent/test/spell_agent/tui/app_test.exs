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

  # Restore the shared supervised LayoutRegistry to its boot state (the empty
  # placeholder the supervisor starts it with -- no :default opt -> frozen pane
  # identity []). Any test that seeds/reshapes the global registry MUST call this
  # on exit, or a later cross-file render test adopts the leftover tree (the
  # registry is session-global, not per-test). Tolerant of an absent registry.
  defp restore_layout_registry do
    case Process.whereis(SpellAgent.Tui.LayoutRegistry) do
      nil ->
        :ok

      _ ->
        SpellAgent.Tui.LayoutRegistry.seed_default(%{
          "type" => "split",
          "dir" => "vertical",
          "children" => []
        })
    end
  end

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

  # ---- PLAN-023 Task C: store-update coalescing ----

  describe "store-update coalescing (PLAN-023 Task C)" do
    test "a burst of {:store_updated} collapses to ONE reproject + render", %{store: store} do
      # A small but non-zero window so all messages in the burst land BEFORE the
      # flush timer fires (the burst is synchronous, far faster than 50ms).
      {:ok, pid} =
        App.start_link(
          name: nil,
          test_mode: {80, 24},
          store: store,
          on_submit: fn _ -> :noop end,
          store_coalesce_ms: 50
        )

      base = Runtime.snapshot(pid).render_count

      # 20 telemetry-style store updates in a tight burst.
      for _ <- 1..20, do: send(pid, {:store_updated, [:tool, :start]})

      # Before the window elapses: the burst armed ONE timer and rendered ZERO
      # times (each arming message returns render?: false).
      :sys.get_state(pid)
      mid = Runtime.snapshot(pid).render_count
      assert mid == base, "the burst rendered #{mid - base} frames before flush, expected 0"

      # After the window: the 20-event burst collapsed to ONE coalesced reproject
      # + render. (A reactive cell armed by that reproject may add at most one more
      # follow-up render via {:cell_resolved}; the contract is COLLAPSE — a small
      # constant, never the 20 the un-coalesced path would draw.)
      Process.sleep(80)
      after_flush = Runtime.snapshot(pid).render_count

      assert (after_flush - base) in 1..2,
             "expected the 20-event burst to collapse to ~1 render, got #{after_flush - base}"

      GenServer.stop(pid)
    end

    test "a single {:store_updated} still renders within the window", %{store: store} do
      {:ok, pid} =
        App.start_link(
          name: nil,
          test_mode: {80, 24},
          store: store,
          on_submit: fn _ -> :noop end,
          store_coalesce_ms: 0
        )

      base = Runtime.snapshot(pid).render_count
      send(pid, {:store_updated, [:tool, :start]})
      Process.sleep(20)
      assert Runtime.snapshot(pid).render_count == base + 1

      GenServer.stop(pid)
    end

    test "keystrokes are not starved during a store-update burst", %{store: store} do
      {:ok, pid} =
        App.start_link(
          name: nil,
          test_mode: {80, 24},
          store: store,
          on_submit: fn _ -> :noop end,
          store_coalesce_ms: 50
        )

      :ok = enter_insert(pid)
      # Interleave a burst of store updates with keystrokes; the keystrokes must
      # still reach the composer immediately (they are not deferred/coalesced).
      for _ <- 1..10, do: send(pid, {:store_updated, [:llm, :start]})
      :ok = type_string(pid, "hi")
      for _ <- 1..10, do: send(pid, {:store_updated, [:tool, :start]})

      assert app_state(pid).composer == "hi"

      GenServer.stop(pid)
    end

    test "mission completion reprojects immediately and cancels a pending flush", %{
      store: store
    } do
      {:ok, pid} =
        App.start_link(
          name: nil,
          test_mode: {80, 24},
          store: store,
          on_submit: fn _ -> :noop end,
          store_coalesce_ms: 5_000
        )

      # Arm a pending (long-window) flush, then deliver a mission-result message.
      send(pid, {:store_updated, [:tool, :start]})
      :sys.get_state(pid)
      assert app_state(pid).store_flush_timer != nil

      base = Runtime.snapshot(pid).render_count
      ref = make_ref()
      send(pid, {ref, {:ok, :finished}})
      :sys.get_state(pid)

      st = app_state(pid)
      assert st.result == {:ok, :finished}
      assert st.running? == false
      # The immediate reproject rendered now (not deferred to the 5s window) and
      # cleared the pending flush + dirty so a later :flush_store is a no-op.
      assert Runtime.snapshot(pid).render_count == base + 1
      assert st.store_flush_timer == nil
      assert st.store_dirty == nil

      GenServer.stop(pid)
    end
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
        pending_leader: false,
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

  defp status_style(widgets) do
    {%ExRatatui.Widgets.Paragraph{style: style}, _} = Enum.at(widgets, 0)
    style
  end

  defp composer_style(widgets) do
    {%ExRatatui.Widgets.Paragraph{style: style}, _} = List.last(widgets)
    style
  end

  # W5 dogfood parity: the status/composer now render from tmpl:: holes over the
  # data/* bag (no more hardcoded status_widget/composer_widget). The exact label
  # STRINGS, COLORS, modal title, and cursor glyph must be byte-identical to the
  # retired fills — this pins the colors the text-only assertions miss.
  test "W5: status label + color survive the hole path exactly", %{store: store} do
    running = App.render(state(%{store: store, running?: true}), %Frame{width: 80, height: 24})
    assert status_text(running) == "● running…  turns 0 · tools 0"
    assert status_style(running).fg == :yellow
    assert :bold in status_style(running).modifiers

    done = App.render(state(%{store: store, result: {:ok, "x"}}), %Frame{width: 80, height: 24})
    assert status_text(done) == "✓ done  turns 0 · tools 0"
    assert status_style(done).fg == :green

    failed =
      App.render(state(%{store: store, result: {:error, :boom}}), %Frame{width: 80, height: 24})

    assert status_text(failed) == "✗ failed  turns 0 · tools 0"
    assert status_style(failed).fg == :red

    idle = App.render(state(%{store: store}), %Frame{width: 80, height: 24})
    assert status_text(idle) =~ "idle"
    assert status_style(idle).fg == :dark_gray
  end

  test "W5: composer text + fg + modal title survive the hole path exactly", %{store: store} do
    insert_ui = Ui.new(focus: :prompt, mode: :insert, panes: [:prompt, :tree, :detail])

    ins =
      App.render(state(%{store: store, composer: "hi", ui: insert_ui}), %Frame{
        width: 80,
        height: 24
      })

    assert composer_text(ins) == "hi▎"
    assert composer_title(ins) =~ "INSERT"
    assert composer_style(ins).fg == :white

    normal_ui = Ui.new(focus: :tree, mode: :normal, panes: [:prompt, :tree, :detail])
    norm = App.render(state(%{store: store, ui: normal_ui}), %Frame{width: 80, height: 24})
    assert composer_title(norm) =~ "NORMAL"
    assert composer_style(norm).fg == :dark_gray
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

    on_exit(&restore_layout_registry/0)

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

  # BUG-012: shadowing the BODY slot itself (not just a pane) silently un-adopted
  # the WHOLE live tree. The old gate recomputed `body_pane_slots/1` of the LIVE
  # tree; a `view/split` body has fresh widget children with NO slot, so the
  # recompute was `[]`, the equality failed, and render fell back to the native
  # default every frame -- the agent's `layout/set` returned ok yet nothing
  # changed. The gate now keys on the FROZEN pane identity captured at seed time,
  # which a body reshape cannot move. This asserts the body reshape reaches the
  # render OUTPUT (the operator's actual screen), which BUG-007's test could not
  # catch (it only shadowed a pane, which keeps the body slots).
  test "BUG-012: an agent shadow on the BODY slot survives the render-adoption gate",
       %{store: store} do
    alias SpellAgent.Tui.{DefaultLayout, LayoutRegistry, Lens}

    st = state(%{store: store})
    pane_names = Enum.map(st.panes, &Atom.to_string(&1.name))
    ui = Ui.new(focus: :tree, panes: [:prompt | Enum.map(st.panes, & &1.name)])
    default = DefaultLayout.tree(ui, pane_names)

    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default})
      _ -> LayoutRegistry.seed_default(default)
    end

    # Restore the shared supervised registry to its boot default on exit: this
    # test reshapes the global registry, and a later cross-file test that renders
    # without re-seeding would otherwise adopt this polluted tree.
    on_exit(&restore_layout_registry/0)

    # The agent reshapes the ENTIRE body into a custom message-history panel --
    # the exact operation from the reported session (a view/split of fresh
    # widgets, none carrying a pane slot).
    assert :ok =
             LayoutRegistry.set("body", %{
               "type" => "split",
               "dir" => "horizontal",
               "constraints" => [["percentage", 100]],
               "children" => [
                 %{
                   "type" => "list",
                   "items" => ["you: hi", "agent: BODY-RESHAPED-PANEL"],
                   "block" => %{
                     "type" => "block",
                     "title" => "Message History",
                     "borders" => ["all"]
                   }
                 }
               ]
             })

    # The LIVE body's pane slots are now empty (fresh widget children, no slot) --
    # exactly the state the old gate rejected...
    assert Lens.body_pane_slots(LayoutRegistry.tree()) == []
    # ...but the FROZEN identity is untouched, so the gate still adopts.
    assert LayoutRegistry.pane_identity() == pane_names

    widgets = App.render(st, %Frame{width: 120, height: 24})
    rendered = Enum.map_join(widgets, "\n", fn {w, _r} -> inspect(w) end)
    assert rendered =~ "BODY-RESHAPED-PANEL"
  end

  test "C-r resets an agent-authored layout to the default even in insert mode", %{store: store} do
    alias SpellAgent.Tui.{DefaultLayout, LayoutRegistry}

    st = state(%{store: store})
    pane_names = Enum.map(st.panes, &Atom.to_string(&1.name))
    ui = Ui.new(focus: :tree, panes: [:prompt | Enum.map(st.panes, & &1.name)])
    default = DefaultLayout.tree(ui, pane_names)

    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default})
      _ -> LayoutRegistry.seed_default(default)
    end

    on_exit(&restore_layout_registry/0)

    assert :ok =
             LayoutRegistry.set("body", %{
               "type" => "paragraph",
               "text" => "CUSTOM-LAYOUT"
             })

    widgets = App.render(st, %Frame{width: 120, height: 24})
    assert Enum.map_join(widgets, "\n", fn {w, _r} -> inspect(w) end) =~ "CUSTOM-LAYOUT"

    insert_state = %{st | ui: Ui.mode(st.ui, :insert), pending_leader: true}
    assert {:noreply, reset_state} = App.handle_event(ctrl("r"), insert_state)
    refute reset_state.pending_leader
    assert reset_state.ui.mode == :insert

    widgets = App.render(reset_state, %Frame{width: 120, height: 24})
    rendered = Enum.map_join(widgets, "\n", fn {w, _r} -> inspect(w) end)
    refute rendered =~ "CUSTOM-LAYOUT"
    assert rendered =~ "detail"
  end

  # BUG-012 honesty (fix B): on a registry that was never seeded with a real
  # layout (frozen identity []), the App's gate can NEVER adopt, so any shadow is
  # futile. set/2 must REJECT loudly instead of returning a hollow ok the agent
  # trusts. The `layout/set` tool surfaces this as an `err` map, not a silent
  # success.
  test "BUG-012: layout/set on an unseeded (non-adoptable) registry rejects honestly" do
    alias SpellAgent.Tui.LayoutRegistry

    # An unseeded registry: the empty-placeholder default has no body -> identity [].
    case Process.whereis(LayoutRegistry) do
      nil ->
        start_supervised!({LayoutRegistry, []})

      _ ->
        LayoutRegistry.seed_default(%{"type" => "split", "dir" => "vertical", "children" => []})
    end

    on_exit(&restore_layout_registry/0)

    refute LayoutRegistry.adoptable?()

    assert {:error, {:not_adoptable, "body"}} =
             LayoutRegistry.set("body", %{"type" => "paragraph", "text" => "x"})

    # The tool surface returns an err map (not a tree), naming the reason.
    result =
      LayoutRegistry.tools()["layout/set"].(%{
        "slot" => "body",
        "source" => %{"type" => "paragraph", "text" => "x"}
      })

    assert Map.get(result, "reason") == "not_adoptable"
    assert Map.get(result, "err") =~ "would not render"
  end

  # BUG-008: render must never let one unencodable widget drop the WHOLE frame.
  # ExRatatui.draw encodes all placements in one pass; a single bad one raises and
  # the live render logs + drops the frame (black/frozen screen). App.render now
  # filters to encodable placements, so a bad shadow costs ONE widget, not the UI.
  test "BUG-008: an unencodable shadow is dropped from render, the frame survives",
       %{store: store} do
    alias SpellAgent.Tui.{DefaultLayout, LayoutRegistry, Lens}

    st = state(%{store: store})
    pane_names = Enum.map(st.panes, &Atom.to_string(&1.name))
    ui = Ui.new(focus: :tree, panes: [:prompt | Enum.map(st.panes, & &1.name)])
    default = DefaultLayout.tree(ui, pane_names)

    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default})
      _ -> LayoutRegistry.seed_default(default)
    end

    on_exit(&restore_layout_registry/0)

    # Force an unencodable widget directly into the live tree, bypassing the
    # set/2 ladder (simulating a paint-time-only failure the probe didn't catch).
    bad = %{"type" => "sparkline", "slot" => "detail", "data" => ["x", "y"]}
    poisoned = Lens.put_at(LayoutRegistry.tree(), "detail", bad)
    :ok = LayoutRegistry.replace(poisoned)

    # Render must NOT raise, and must still produce the other (good) widgets.
    widgets = App.render(st, %Frame{width: 120, height: 24})
    assert is_list(widgets)
    assert length(widgets) >= 1
    # Every surviving placement encodes cleanly (the bad one was filtered).
    assert Enum.all?(widgets, fn {w, r} ->
             try do
               ExRatatui.Bridge.encode_command({w, r})
               true
             rescue
               _ -> false
             end
           end)
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

  # ---- C-w frame leader: spatial region selection (geometry-driven) ----

  defp ctrl_w(pid), do: Runtime.inject_event(pid, ctrl("w"))

  test "C-w l focuses the most-RIGHTWARD region by layout geometry", %{store: store} do
    {:ok, pid} =
      App.start_link(name: nil, test_mode: {80, 24}, store: store, on_submit: fn _ -> :noop end)

    # Body is history | tree | detail, left to right. C-w l = rightmost = detail,
    # resolved from the placed rects (not a hardcoded slot).
    :ok = ctrl_w(pid)
    :ok = Runtime.inject_event(pid, key("l"))
    assert ui(pid).focus == :detail

    # C-w h = leftmost = history.
    :ok = ctrl_w(pid)
    :ok = Runtime.inject_event(pid, key("h"))
    assert ui(pid).focus == :history

    GenServer.stop(pid)
  end

  test "C-w l lands on the C-e cells drawer when it is shown (rightmost overlay)", %{
    store: store
  } do
    {:ok, pid} =
      App.start_link(name: nil, test_mode: {80, 24}, store: store, on_submit: fn _ -> :noop end)

    # Open the cells drawer (C-e). It is drawn as the rightmost column, so it now
    # IS the most-rightward region — C-w l must select it, by position.
    :ok = Runtime.inject_event(pid, ctrl("e"))
    assert app_state(pid).ui.flags["cells-drawer"] == true

    :ok = ctrl_w(pid)
    :ok = Runtime.inject_event(pid, key("l"))
    assert ui(pid).focus == :cells

    GenServer.stop(pid)
  end

  test "the leader is one-shot: a non-direction key cancels with no move", %{store: store} do
    {:ok, pid} =
      App.start_link(name: nil, test_mode: {80, 24}, store: store, on_submit: fn _ -> :noop end)

    focus0 = ui(pid).focus
    :ok = ctrl_w(pid)
    assert app_state(pid).pending_leader == true
    # 'x' is not a direction → cancel, consume, no focus change.
    :ok = Runtime.inject_event(pid, key("x"))
    assert app_state(pid).pending_leader == false
    assert ui(pid).focus == focus0

    GenServer.stop(pid)
  end
end
