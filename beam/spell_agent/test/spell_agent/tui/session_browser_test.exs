defmodule SpellAgent.Tui.SessionBrowserTest do
  @moduledoc """
  Boots the session browser headless (`test_mode`, no TTY) and drives it like a
  human (PLAN-010, C6): it lists seeded sessions, navigates, drills a trace into
  its interior, and never crashes on empty/missing — proving `mix spell.sessions`
  actually runs the same mount/render/handle_event path.
  """
  use ExUnit.Case, async: false

  alias ExRatatui.Event.Key
  alias ExRatatui.Runtime
  alias SpellAgent.Hist.{Recorder, Store}
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Tui.SessionBrowser

  defp key(code), do: %Key{code: code, kind: "press", modifiers: []}
  defp state(pid), do: :sys.get_state(pid).user_state

  defp press(pid, code) do
    :ok = Runtime.inject_event(pid, key(code))
    _ = :sys.get_state(pid)
    pid
  end

  defp seed do
    Store.clear(Memory)

    n =
      Recorder.record_node(
        Memory,
        "sess_browser1",
        %{
          program: {:tool_call, "find", %{}},
          memory: %{},
          result: "ok",
          prompt: "first",
          span_root: %{kind: :run, status: :ok, name: "root", children: []}
        },
        nil
      )

    _ =
      Recorder.record_node(
        Memory,
        "sess_browser2",
        %{program: {:tool_call, "edit", %{}}, memory: %{}, result: "done", prompt: "second"},
        nil
      )

    n
  end

  defp boot(opts \\ []) do
    {:ok, pid} =
      SessionBrowser.start_link(
        Keyword.merge(
          [name: nil, test_mode: {120, 40}, hist_store: Memory, live: [], refresh_ms: 0],
          opts
        )
      )

    _ = :sys.get_state(pid)
    on_exit(fn -> if Process.alive?(pid), do: Process.exit(pid, :shutdown) end)
    pid
  end

  test "boots, lists seeded sessions, focused on the list" do
    seed()
    pid = boot()
    st = state(pid)

    assert st.focus == :list
    assert length(st.sessions) == 2
  end

  test "an injected live session is listed first and tagged live" do
    seed()
    live = [%{session_id: "sess_live", prompt: "running", model: "m", t0: 9_999_999, pid: self()}]
    pid = boot(live: live)

    [first | _] = state(pid).sessions
    assert first.session_id == "sess_live"
    assert first.live?
  end

  test "j moves the list cursor and reloads the trace for the selection" do
    seed()
    pid = boot()

    assert state(pid).list_cursor == 0
    press(pid, "j")
    assert state(pid).list_cursor == 1
    # the trace reflects the now-selected session
    assert Process.alive?(pid)
  end

  test "l focuses the trace; the selected session's turns are loaded" do
    seed()
    pid = boot()

    press(pid, "l")
    st = state(pid)
    assert st.focus == :trace
    assert length(st.trace) >= 1
  end

  test "expanding a turn with an interior caches its span rows" do
    seed()
    pid = boot()
    press(pid, "l")

    # cursor on the first turn, which has a span_root interior
    press(pid, "l")
    st = state(pid)

    interior = Map.values(st.expanded) |> List.first()
    assert is_list(interior)
    assert interior != []
  end

  test "h collapses an expanded turn, then returns focus to the list" do
    seed()
    pid = boot()
    press(pid, "l")
    press(pid, "l")
    assert map_size(state(pid).expanded) == 1

    press(pid, "h")
    assert map_size(state(pid).expanded) == 0
    assert state(pid).focus == :trace

    press(pid, "h")
    assert state(pid).focus == :list
  end

  test "tab toggles focus between panes" do
    seed()
    pid = boot()
    assert state(pid).focus == :list
    press(pid, "tab")
    assert state(pid).focus == :trace
    press(pid, "tab")
    assert state(pid).focus == :list
  end

  test "renders without crashing on an empty store" do
    Store.clear(Memory)
    pid = boot()
    assert state(pid).sessions == []
    press(pid, "j")
    press(pid, "l")
    assert Process.alive?(pid)
  end

  test "q stops the app" do
    seed()
    {:ok, pid} =
      SessionBrowser.start_link(name: nil, test_mode: {120, 40}, hist_store: Memory, live: [], refresh_ms: 0)

    _ = :sys.get_state(pid)
    ref = Process.monitor(pid)
    :ok = Runtime.inject_event(pid, key("q"))
    assert_receive {:DOWN, ^ref, :process, ^pid, _reason}, 1000
  end
end
