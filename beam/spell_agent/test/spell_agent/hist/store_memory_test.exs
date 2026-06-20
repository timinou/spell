defmodule SpellAgent.Hist.Store.MemoryTest do
  @moduledoc """
  Contract tests for the `Hist.Store` behaviour via the Memory impl (PLAN-001 W0).

  Defends the logical key space and `list/2` scoping that every capability layer
  builds on — a node written under one session must not leak into another's slice,
  and session-global kinds (tools, crystals) must ignore session scope.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Crystal, Mark, Node, Session, ToolDef}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  test "put/fetch round-trips a node verbatim" do
    node = %Node{id: "n1", session: "s1", seq: 1, say: "hello", binds: %{x: 1}}
    :ok = Store.put(Memory, {:node, "s1", "n1"}, node)
    assert {:ok, ^node} = Store.fetch(Memory, {:node, "s1", "n1"})
  end

  test "fetch of an absent key is :error" do
    assert :error = Store.fetch(Memory, {:node, "s1", "ghost"})
  end

  test "delete removes a key idempotently" do
    Store.put(Memory, {:mark, "s1", "m1"}, %Mark{id: "m1", session: "s1", node_id: "n1", kind: :decision})
    assert :ok = Store.delete(Memory, {:mark, "s1", "m1"})
    assert :error = Store.fetch(Memory, {:mark, "s1", "m1"})
    assert :ok = Store.delete(Memory, {:mark, "s1", "m1"})
  end

  test "list/:node scopes to a session — no cross-session leak" do
    Store.put(Memory, {:node, "s1", "n1"}, %Node{id: "n1", session: "s1", seq: 1})
    Store.put(Memory, {:node, "s1", "n2"}, %Node{id: "n2", session: "s1", seq: 2})
    Store.put(Memory, {:node, "s2", "n3"}, %Node{id: "n3", session: "s2", seq: 1})

    ids = Memory |> Store.list(:node, "s1") |> Enum.map(& &1.id) |> Enum.sort()
    assert ids == ["n1", "n2"]

    all_ids = Memory |> Store.list(:node, nil) |> Enum.map(& &1.id) |> Enum.sort()
    assert all_ids == ["n1", "n2", "n3"]
  end

  test "session-global kinds (tool, crystal) ignore session scope" do
    Store.put(Memory, {:tool, "blast"}, %ToolDef{name: "blast", source: "(...)"})
    Store.put(Memory, {:crystal, "c1"}, %Crystal{id: "c1", name: "hot", source: "(...)"})

    assert [%ToolDef{name: "blast"}] = Store.list(Memory, :tool, nil)
    assert [%Crystal{id: "c1"}] = Store.list(Memory, :crystal, "s-anything")
  end

  test "list of an empty kind is []" do
    assert [] = Store.list(Memory, :session, nil)
  end

  test "session round-trips with its cursor map" do
    sess = %Session{id: "s1", prompt: "go", cursors: %{main: "n2"}}
    Store.put(Memory, {:session, "s1"}, sess)
    assert {:ok, %Session{cursors: %{main: "n2"}}} = Store.fetch(Memory, {:session, "s1"})
  end
end
