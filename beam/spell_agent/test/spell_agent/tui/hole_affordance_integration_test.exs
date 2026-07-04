defmodule SpellAgent.Tui.HoleAffordanceIntegrationTest do
  @moduledoc """
  End-to-end proof (PLAN-024 Wave 3 / FEAT-020): a fillable hole's declared
  slot auto-generates live keymap affordances, a real keystroke posts a
  `:resolution` via `black/post`, and the mesh watch fires the queued task —
  the FULL doc-17 human-surface loop, over the REAL `App` GenServer with
  injected keystrokes (no shortcuts).

  Uses the real `ExRatatui.App` under `test_mode`, injects keystrokes via
  `Runtime.inject_event/2` (mirrors `app_test.exs`'s established pattern), and
  drives a REAL `Mesh.Watcher` + `Hist.Store.Memory` so `:decision` ->
  keystroke -> `:resolution` -> queued-task-fires is proven against the actual
  production stack, not a hand-assembled shortcut.
  """
  use ExUnit.Case, async: false

  alias ExRatatui.Event.Key
  alias ExRatatui.Runtime
  alias SpellAgent.Clock
  alias SpellAgent.Hist.Store, as: HistStore
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Mesh.Namespace
  alias SpellAgent.Mesh.Store, as: MeshStore
  alias SpellAgent.Tui.{App, KeymapRegistry, LayoutRegistry, PaneRegistry, Store, Ui}

  setup do
    {:ok, store} = Store.start_link(name: nil)

    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    HistStore.clear(Memory)

    for {mod, opts} <- [{PaneRegistry, []}, {KeymapRegistry, []}] do
      case Process.whereis(mod) do
        nil -> start_supervised!({mod, opts})
        _ -> :ok
      end
    end

    PaneRegistry.reset()
    KeymapRegistry.reset()

    test_pid = self()
    runner = fn prompt, opts -> send(test_pid, {:woke, prompt, opts}) end

    clock_name = :"hole_aff_clock_#{System.unique_integer([:positive])}"
    start_supervised!({Clock, [name: clock_name, store: Memory, runner: runner]}, id: clock_name)

    watcher_name = :"hole_aff_watcher_#{System.unique_integer([:positive])}"

    start_supervised!(
      {SpellAgent.Mesh.Watcher, [name: watcher_name, store: Memory, clock: clock_name, enabled: true]},
      id: watcher_name
    )

    on_exit(fn ->
      case Process.whereis(LayoutRegistry) do
        nil -> :ok
        _ -> LayoutRegistry.seed_default(%{"type" => "split", "dir" => "vertical", "children" => []})
      end
    end)

    %{store: store}
  end

  defp key(code), do: %Key{code: code, kind: "press", modifiers: []}

  defp count_wakes(acc \\ 0) do
    receive do
      {:woke, _, _} -> count_wakes(acc + 1)
    after
      300 -> acc
    end
  end

  defp app_state(pid), do: :sys.get_state(pid).user_state

  # App.mount/1 SEEDS (overwrites) LayoutRegistry with the native default via
  # seed_layout/1 — so a shadow must be set AFTER start_link, then a reproject
  # forced before checking/using the affordance. `Runtime.inject_event/2` only
  # dispatches through `App.handle_event/2` (Key events); a `Resize` struct is
  # normally delivered via `handle_info` by REAL terminal polling, not the
  # inject_event path, so it is NOT a usable trigger under test_mode (verified:
  # injecting one leaves `last_area` unchanged). The reliable trigger is a REAL
  # navigation keystroke that resolves to an `:intent` (any `{:intent, _, _}` ->
  # `reproject/2`, per handle_key_event's normal-mode dispatch) — C-j/C-k (ring
  # focus) always resolves. On a 2-pane ring, C-j TWICE returns focus to where
  # it started while forcing two reprojects (so this is safe to call BEFORE
  # asserting on the ORIGINAL focus's affordances too).
  defp force_reproject(pid) do
    ctrl_j = %ExRatatui.Event.Key{code: "j", kind: "press", modifiers: ["ctrl"]}
    :ok = Runtime.inject_event(pid, ctrl_j)
    :ok = Runtime.inject_event(pid, ctrl_j)
    :sys.get_state(pid)
  end

  test "a decision's enum slot renders affordances; pressing the variant chord posts a :resolution; the queued task fires",
       %{store: store} do
    session_id = "hole-aff-#{System.unique_integer([:positive])}"

    # 1. Post a :decision to the SAME region the App will use (its hist_session
    #    IS the mesh region — PLAN-024 Wave 3's minimal region wiring).
    verbs = Namespace.tools(Memory, "agent", session_id)

    %{"id" => decision_seq} =
      verbs["black/post"].(%{
        "kind" => "decision",
        "payload" => %{"question" => "ship it?"}
      })

    # 2. Watch for a matching :resolution -> the queued wake.
    verbs["black/watch"].(%{
      "when" => %{"kind" => "resolution", "where" => %{"decision" => decision_seq}},
      "wake" => %{"prompt" => "decision answered"}
    })

    # 3. Mount the REAL App (focus: :detail) — mount SEEDS the registry with the
    #    native default, so the shadow is applied AFTER start_link.
    ui = Ui.new(focus: :detail, panes: [:tree, :detail])

    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        hist_store: Memory,
        hist_session: session_id,
        on_submit: fn _ -> :noop end,
        panes: [
          %{name: :tree, module: SpellAgent.Tui.Panes.SpanTree, assigns: %{}},
          %{name: :detail, module: SpellAgent.Tui.Panes.Detail, assigns: %{}}
        ],
        ui: ui
      )

    # Shadow the "detail" slot with a fillable hole (an enum affordance
    # resolving THIS decision), then force a reproject so
    # sync_hole_affordances/1 picks it up.
    :ok =
      LayoutRegistry.set("detail", %{
        "type" => "paragraph",
        "text" => "ship it?",
        "tags" => %{
          "focusable" => true,
          "affordance" => %{
            "answer-schema" => %{"choice" => ["proceed", "skip"]},
            "resolves" => decision_seq
          }
        }
      })

    force_reproject(pid)

    # Focus is already :detail (the fillable node) — press "1" (the FIRST
    # generated chord, "proceed") through the REAL event pipeline.
    :ok = Runtime.inject_event(pid, key("1"))
    :sys.get_state(pid)

    # The resolution landed on the mesh region for THIS session.
    resolutions = MeshStore.by_kind(Memory, session_id, :resolution)
    assert length(resolutions) == 1
    assert hd(resolutions).payload["decision"] == decision_seq
    assert hd(resolutions).payload["answer"]["choice"] == "proceed"

    # The queued task fired exactly once.
    assert count_wakes() == 1

    GenServer.stop(pid)
  end

  test "a :tier :policy slot renders no human-facing affordance (doc-16 symmetry) — the chord is a no-op",
       %{store: store} do
    ui = Ui.new(focus: :detail, panes: [:tree, :detail])

    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        hist_store: Memory,
        hist_session: "policy-tier-#{System.unique_integer([:positive])}",
        on_submit: fn _ -> :noop end,
        panes: [
          %{name: :tree, module: SpellAgent.Tui.Panes.SpanTree, assigns: %{}},
          %{name: :detail, module: SpellAgent.Tui.Panes.Detail, assigns: %{}}
        ],
        ui: ui
      )

    :ok =
      LayoutRegistry.set("detail", %{
        "type" => "paragraph",
        "text" => "auto-resolved by a policy",
        "tags" => %{
          "focusable" => true,
          "affordance" => %{
            "answer-schema" => %{"choice" => ["proceed", "skip"]},
            "resolves" => 1,
            "tier" => "policy"
          }
        }
      })

    force_reproject(pid)

    # No affordance bindings were installed for a :tier :policy slot.
    assert KeymapRegistry.bindings(:hole_affordance) == []

    # "1" resolves through the ordinary TurnNav/Global cascade (a no-op scroll,
    # not a resolution post) — the chord was never claimed by hole_affordance.
    :ok = Runtime.inject_event(pid, key("1"))
    :sys.get_state(pid)

    GenServer.stop(pid)
  end

  test "moving focus away from a fillable node tears down its affordances (no dangling chords)",
       %{store: store} do
    ui = Ui.new(focus: :detail, panes: [:tree, :detail])

    {:ok, pid} =
      App.start_link(
        name: nil,
        test_mode: {80, 24},
        store: store,
        hist_store: Memory,
        hist_session: "teardown-#{System.unique_integer([:positive])}",
        on_submit: fn _ -> :noop end,
        panes: [
          %{name: :tree, module: SpellAgent.Tui.Panes.SpanTree, assigns: %{}},
          %{name: :detail, module: SpellAgent.Tui.Panes.Detail, assigns: %{}}
        ],
        ui: ui
      )

    :ok =
      LayoutRegistry.set("detail", %{
        "type" => "paragraph",
        "text" => "fillable",
        "tags" => %{
          "focusable" => true,
          "affordance" => %{"answer-schema" => "bool", "resolves" => 1}
        }
      })

    force_reproject(pid)
    assert KeymapRegistry.bindings(:hole_affordance) != []

    # C-j moves focus away from :detail (to :tree, the only other ring member).
    :ok = Runtime.inject_event(pid, %Key{code: "j", kind: "press", modifiers: ["ctrl"]})
    :sys.get_state(pid)

    assert app_state(pid).ui.focus != :detail
    assert KeymapRegistry.bindings(:hole_affordance) == []

    GenServer.stop(pid)
  end
end
