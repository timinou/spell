defmodule SpellAgent.Hist.QueryTest do
  @moduledoc """
  Query contract (PLAN-001 C4): read-only interrogation over stored nodes.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Node, Query, Recorder}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  @impl_store Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp seed_session do
    find =
      Recorder.record_node(@impl_store, "s1", %{
        program: {:tool_call, "find", %{target: "lib/foo.ex"}},
        memory: %{},
        result: %{ok: true},
        tool_calls: [
          %{name: "find", args: %{target: "lib/foo.ex"}, result: %{ok: true}}
        ]
      }, nil)

    edit =
      Recorder.record_node(@impl_store, "s1", %{
        program: {:tool_call, "edit", %{target: "lib/foo.ex", content: "x"}},
        memory: %{},
        result: nil,
        tool_calls: [
          %{name: "edit", args: %{target: "lib/foo.ex"}, result: %{err: "locked"}}
        ]
      }, find.id)

    defn =
      Recorder.record_node(@impl_store, "s1", %{
        program: {:def, :foo, 1, %{}},
        memory: %{foo: 1},
        result: nil,
        tool_calls: []
      }, edit.id)

    {find, edit, defn}
  end

  test "tool_calls/3 returns every tool call flattened by node seq" do
    seed_session()
    calls = Query.tool_calls(@impl_store, "s1")
    assert length(calls) == 2
    assert Enum.map(calls, & &1.tool) == ["find", "edit"]
    assert Enum.all?(calls, & &1.node_id)
  end

  test "tool_calls/3 filters by name" do
    seed_session()
    assert [%{tool: "edit"}] = Query.tool_calls(@impl_store, "s1", name: "edit")
  end

  test "tool_calls/3 filters by status :error" do
    seed_session()
    assert [%{tool: "edit", status: :error}] = Query.tool_calls(@impl_store, "s1", status: :error)
  end

  test "forms/3 matches {:tool_call, name} structurally" do
    {_find, edit, _defn} = seed_session()
    assert [%Node{id: id}] = Query.forms(@impl_store, "s1", {:tool_call, "edit"})
    assert id == edit.id
  end

  test "forms/3 accepts a predicate function" do
    seed_session()
    matches = Query.forms(@impl_store, "s1", fn form -> match?({:def, _, _, _}, form) end)
    assert length(matches) == 1
    assert hd(matches).form == {:def, :foo, 1, %{}}
  end

  test "contains_tool_call?/2 recurses into nested AST" do
    nested = {:do, [{:var, :x}, {:tool_call, "edit", %{}}]}
    assert Query.contains_tool_call?(nested, "edit")
    refute Query.contains_tool_call?(nested, "find")
  end

  test "defq/3 locates symbol definitions" do
    seed_session()
    assert [%{seq: seq, form_src: src}] = Query.defq(@impl_store, "s1", :foo)
    assert seq == 3
    assert is_binary(src)
  end

  test "diff/4 compares two turns by seq" do
    seed_session()
    %{a: a, b: b, same?: same?} = Query.diff(@impl_store, "s1", 1, 2)
    assert is_binary(a)
    assert is_binary(b)
    refute same?
    assert Query.diff(@impl_store, "s1", 1, 1).same?
  end

  test "cost/3 sums tokens across the session" do
    find =
      Recorder.record_node(@impl_store, "s1", %{
        program: "(+ 1 1)",
        memory: %{},
        tokens: %{input: 10, output: 2}
      }, nil)

    Recorder.record_node(@impl_store, "s1", %{
      program: "(+ 2 2)",
      memory: %{},
      tokens: %{input: 20, output: 5}
    }, find.id)

    assert %{input: 30, output: 7, total: 37, nodes_counted: 2} =
             Query.cost(@impl_store, "s1")
  end

  test "cost/3 counts only nodes at/after a mark" do
    n1 = Recorder.record_node(@impl_store, "s1", %{program: "1", memory: %{}, tokens: %{input: 10, output: 1}}, nil)
    n2 = Recorder.record_node(@impl_store, "s1", %{program: "2", memory: %{}, tokens: %{input: 20, output: 2}}, n1.id)
    _n3 = Recorder.record_node(@impl_store, "s1", %{program: "3", memory: %{}, tokens: %{input: 30, output: 3}}, n2.id)

    Store.put(@impl_store, {:mark, "s1", "bookmark"}, %{node_id: n2.id, seq: n2.seq})

    assert %{input: 50, output: 5, total: 55, nodes_counted: 2} =
             Query.cost(@impl_store, "s1", since_mark: "bookmark")
  end

  test "cost/3 ignores nodes with nil tokens" do
    Recorder.record_node(@impl_store, "s1", %{program: "1", memory: %{}}, nil)
    assert %{input: 0, output: 0, total: 0, nodes_counted: 0} = Query.cost(@impl_store, "s1")
  end
end
