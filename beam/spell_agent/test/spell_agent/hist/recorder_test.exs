defmodule SpellAgent.Hist.RecorderTest do
  @moduledoc """
  Recording contract (PLAN-001 W1, C1): a `Step`'s turns become a linked node chain
  whose `binds` are per-turn DELTAS (not the cumulative env), handles are realized,
  and the session `:main` cursor lands on the last turn.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Node, Recorder, Session}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  @impl_store Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp turn(number, program, result, memory, extra \\ %{}) do
    Map.merge(
      %{
        number: number,
        program: program,
        result: result,
        prints: [],
        tool_calls: [],
        memory: memory,
        raw_response: "raw#{number}",
        success?: true,
        type: :normal
      },
      extra
    )
  end

  test "turns become a linked chain; binds are per-turn deltas" do
    step = %PtcRunner.Step{
      turns: [
        turn(1, "(def x 1)", nil, %{x: 1}),
        turn(2, "(def y 2)", nil, %{x: 1, y: 2}),
        turn(3, "(+ x y)", 3, %{x: 1, y: 2})
      ]
    }

    last = Recorder.record_step(@impl_store, "s1", step, prompt: "go")
    assert is_binary(last)

    nodes = Store.list(@impl_store, :node, "s1") |> Enum.sort_by(& &1.seq)
    assert length(nodes) == 3

    [n1, n2, n3] = nodes
    # deltas: turn 1 introduces x, turn 2 introduces only y, turn 3 introduces nothing
    assert n1.binds == %{x: 1}
    assert n2.binds == %{y: 2}
    assert n3.binds == %{}

    # chain links
    assert n1.parent_id == nil
    assert n2.parent_id == n1.id
    assert n3.parent_id == n2.id

    # cursor on last
    assert {:ok, %Session{cursors: %{main: ^last}}} = Store.fetch(@impl_store, {:session, "s1"})
    assert last == n3.id
  end

  test "result is captured and a failing turn is marked :error" do
    step = %PtcRunner.Step{
      turns: [
        turn(1, "(/ 1 0)", nil, %{}, %{success?: false})
      ]
    }

    Recorder.record_step(@impl_store, "s1", step)
    [n] = Store.list(@impl_store, :node, "s1")
    assert n.status == :error
  end

  test "record_node appends a single synthetic node under a parent" do
    a = Recorder.record_node(@impl_store, "s1", %{program: "(def a 1)", memory: %{a: 1}}, nil)
    b = Recorder.record_node(@impl_store, "s1", %{program: "(def b 2)", memory: %{a: 1, b: 2}}, a.id)

    assert b.parent_id == a.id
    assert b.binds == %{b: 2}
  end

  test "content id is stable for same form+parent (dedup key)" do
    a = Recorder.record_node(@impl_store, "s1", %{program: "(f)", memory: %{}}, nil)
    a2 = Recorder.record_node(@impl_store, "s2", %{program: "(f)", memory: %{}}, nil)
    # same form, same (nil) parent → same content id across sessions
    assert a.id == a2.id
  end
end
