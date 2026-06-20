defmodule SpellAgent.Hist.InterfaceTest do
  @moduledoc """
  Defends the interface upgrades that the TUI integration motivated (PLAN-001):
  the typed `Hist.View` return, the interleaved user/assistant chat transcript
  (via `Node.prompt` on step heads), and the `Hist` facade (record/resume/window/
  sessions/latest with a default store). Each test pins an externally observable
  contract a consumer depends on.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist
  alias SpellAgent.Hist.{Node, Reconstitute, Recorder, Store, View}
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  # --- View: at/3 returns a typed struct, still map-destructurable -----------

  test "resume/at returns a %View{} carrying session_id, cursor, and tip" do
    n =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(def x 1)", memory: %{x: 1}, result: "hi"},
        nil
      )

    cursor_to(n)

    {:ok, view} = Reconstitute.at(Memory, "s")
    assert %View{session_id: "s", cursor: :main} = view
    assert view.tip.id == n.id
    # a View is still a map: legacy destructuring keeps working
    assert %{env: %{x: 1}} = view
  end

  # --- Transcript: interleaved user + assistant in path order ----------------

  test "to_messages interleaves the step-head prompt with the assistant say" do
    a =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(a)", memory: %{}, result: "first answer", prompt: "do A"},
        nil
      )

    b =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(b)", memory: %{}, result: "second answer", prompt: "then B"},
        a.id
      )

    cursor_to(b)

    {:ok, %View{messages: msgs}} = Reconstitute.at(Memory, "s")

    assert msgs == [
             %{role: :user, content: "do A"},
             %{role: :assistant, content: "first answer"},
             %{role: :user, content: "then B"},
             %{role: :assistant, content: "second answer"}
           ]
  end

  test "interior turns (no prompt) contribute only an assistant message" do
    head =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(h)", memory: %{}, result: "opening", prompt: "go"},
        nil
      )

    # interior turn: prompt nil
    tail =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(t)", memory: %{}, result: "continuation"},
        head.id
      )

    cursor_to(tail)

    {:ok, %View{messages: msgs}} = Reconstitute.at(Memory, "s")

    assert msgs == [
             %{role: :user, content: "go"},
             %{role: :assistant, content: "opening"},
             %{role: :assistant, content: "continuation"}
           ]
  end

  test "record_step tags only the head turn with the prompt" do
    step = %PtcRunner.Step{
      turns: [
        %{
          number: 1,
          program: nil,
          prints: [],
          tool_calls: [],
          memory: %{},
          raw_response: nil,
          success?: true,
          type: :normal,
          result: "t1"
        },
        %{
          number: 2,
          program: nil,
          prints: [],
          tool_calls: [],
          memory: %{},
          raw_response: nil,
          success?: true,
          type: :normal,
          result: "t2"
        }
      ]
    }

    Hist.record("s", step, store: Memory, prompt: "the mission")

    [n1, n2] = Store.list(Memory, :node, "s") |> Enum.sort_by(& &1.seq)
    assert n1.prompt == "the mission"
    assert n2.prompt == nil
  end

  # --- Facade: one door, default store, session enumeration ------------------

  test "facade default_store falls back to Memory and is overridable per call" do
    # No app config set in this isolated test -> Memory fallback.
    assert Hist.default_store() == Memory
  end

  test "sessions/latest enumerate recorded sessions newest-first" do
    older = %PtcRunner.Step{turns: [turn("a")]}
    newer = %PtcRunner.Step{turns: [turn("b")]}

    Hist.record("old", older, store: Memory, prompt: "old")
    # ensure a strictly later t0
    Process.sleep(2)
    Hist.record("new", newer, store: Memory, prompt: "new")

    ids = Hist.sessions(store: Memory) |> Enum.map(& &1.id)
    assert ids == ["new", "old"]
    assert Hist.latest(store: Memory).id == "new"
  end

  test "latest is nil when nothing is recorded" do
    assert Hist.latest(store: Memory) == nil
  end

  test "facade resume returns the same View as Reconstitute.at" do
    n =
      Recorder.record_node(
        Memory,
        "s",
        %{program: "(def y 2)", memory: %{y: 2}, result: "ok", prompt: "p"},
        nil
      )

    cursor_to(n)

    {:ok, via_facade} = Hist.resume("s", store: Memory)
    {:ok, via_direct} = Reconstitute.at(Memory, "s")
    assert via_facade == via_direct
    assert %View{env: %{y: 2}} = via_facade
  end

  # --- helpers ---------------------------------------------------------------

  defp turn(say) do
    %{
      number: 1,
      program: nil,
      prints: [],
      tool_calls: [],
      memory: %{},
      raw_response: nil,
      success?: true,
      type: :normal,
      result: say
    }
  end

  defp cursor_to(%Node{id: id, session: sid}) do
    {:ok, sess} = Store.fetch(Memory, {:session, sid})
    Store.put(Memory, {:session, sid}, %{sess | cursors: Map.put(sess.cursors, :main, id)})
  end
end
