defmodule SpellAgent.Hist.ReconstituteTest do
  @moduledoc """
  Resume contract (PLAN-001 W1, C1): rebuilding state at a cursor folds the realized
  binds along root→cursor into the exact env the agent had, restores its
  runtime-authored tools, and projects the chat lens — deterministically, with no
  execution. Same log → same env, every call.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Reconstitute, Recorder, Snapshot, ToolDef}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp seed_session do
    a = Recorder.record_node(Memory, "s1", %{program: "(def plan :draft)", memory: %{plan: :draft}, result: "started"}, nil)
    b = Recorder.record_node(Memory, "s1", %{program: "(def plan :final)", memory: %{plan: :final}, result: "refined"}, a.id)
    c = Recorder.record_node(Memory, "s1", %{program: "(def count 7)", memory: %{plan: :final, count: 7}, result: "done"}, b.id)
    # set :main cursor on c
    {:ok, sess} = Store.fetch(Memory, {:session, "s1"})
    Store.put(Memory, {:session, "s1"}, %{sess | cursors: %{main: c.id}})
    {a, b, c}
  end

  test "env folds deltas with later turns overriding earlier (plan :draft -> :final)" do
    seed_session()
    {:ok, %{env: env}} = Reconstitute.at(Memory, "s1")
    assert env == %{plan: :final, count: 7}
  end

  test "reconstitution is deterministic" do
    seed_session()
    {:ok, r1} = Reconstitute.at(Memory, "s1")
    {:ok, r2} = Reconstitute.at(Memory, "s1")
    assert r1.env == r2.env
    assert r1.messages == r2.messages
  end

  test "messages project assistant says in path order (chat lens)" do
    seed_session()
    {:ok, %{messages: msgs}} = Reconstitute.at(Memory, "s1")
    assert msgs == [
             %{role: :assistant, content: "started"},
             %{role: :assistant, content: "refined"},
             %{role: :assistant, content: "done"}
           ]
  end

  test "runtime-authored tools are restored at the cursor" do
    a = Recorder.record_node(Memory, "s1", %{program: "(tool/define-tool ...)", memory: %{}, tool_calls: [%{name: "define-tool", args: %{"name" => "blast"}}]}, nil)
    {:ok, sess} = Store.fetch(Memory, {:session, "s1"})
    Store.put(Memory, {:session, "s1"}, %{sess | cursors: %{main: a.id}})
    # a durable ToolDef exists for blast
    Store.put(Memory, {:tool, "blast"}, %ToolDef{name: "blast", source: "(...)", scope: :durable})

    {:ok, %{tools: tools}} = Reconstitute.at(Memory, "s1")
    assert [%ToolDef{name: "blast", scope: :durable}] = tools
  end

  test "snapshot accelerates without changing the result" do
    {_a, b, _c} = seed_session()
    # plant a snapshot at b with a FULL env; reconstitute must still reach c's env
    Store.put(Memory, {:snap, "s1", b.id}, %Snapshot{session: "s1", node_id: b.id, env: %{plan: :final}, tools: []})

    {:ok, %{env: env}} = Reconstitute.at(Memory, "s1")
    assert env == %{plan: :final, count: 7}
  end

  test "missing session / cursor are explicit errors" do
    assert {:error, :no_session} = Reconstitute.at(Memory, "ghost")
    Store.put(Memory, {:session, "s2"}, %SpellAgent.Hist.Session{id: "s2", cursors: %{}})
    assert {:error, :no_cursor} = Reconstitute.at(Memory, "s2")
  end
end
