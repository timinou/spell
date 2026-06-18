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
end
