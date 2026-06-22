defmodule SpellAgent.Hist.TraceTest do
  @moduledoc """
  The trace reader (PLAN-010, C4): a session folds to node rows in seq order, and
  a node's span_root flattens to depth-tagged interior rows (DFS pre-order,
  mixed-key tolerant) — the read side of "read their traces".
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Recorder, Store, Trace}
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  test "rows/2 folds a session to node rows in seq order with essentials" do
    a =
      Recorder.record_node(
        Memory,
        "s",
        %{
          program: {:tool_call, "find", %{}},
          memory: %{},
          result: "found",
          tokens: %{input: 1, output: 2},
          prompt: "go"
        },
        nil
      )

    _b =
      Recorder.record_node(
        Memory,
        "s",
        %{program: {:def, :plan, 1, %{}}, memory: %{plan: 1}, result: "planned"},
        a.id
      )

    rows = Trace.rows(Memory, "s")

    assert [r1, r2] = rows
    assert r1.seq < r2.seq
    assert r1.prompt == "go"
    assert r1.tokens == %{input: 1, output: 2}
    assert r1.has_interior? == false
    assert is_binary(r2.form_src)
  end

  test "rows/2 on an unrecorded session is empty" do
    assert Trace.rows(Memory, "nope") == []
  end

  test "interior/1 flattens span_root DFS pre-order, depth-tagged" do
    root = %{
      kind: :run,
      status: :ok,
      name: "root",
      children: [
        %{kind: :llm, status: :ok, name: "haiku", children: []},
        %{
          kind: :tool,
          status: :error,
          meta: %{tool_name: "edit"},
          children: [%{kind: :run, status: :ok, name: "nested", children: []}]
        }
      ]
    }

    n = Recorder.record_node(Memory, "s", %{program: nil, memory: %{}, span_root: root}, nil)

    rows = Trace.interior(n)

    assert Enum.map(rows, & &1.depth) == [0, 1, 1, 2]
    assert Enum.map(rows, & &1.kind) == [:run, :llm, :tool, :run]
    # the tool span's name comes from meta.tool_name (mixed-key fallback)
    assert Enum.at(rows, 2).name == "edit"
    assert Enum.at(rows, 2).status == :error
  end

  test "interior/1 tolerates a missing or non-map span_root" do
    n = Recorder.record_node(Memory, "s", %{program: nil, memory: %{}}, nil)
    assert n.span_root == nil
    assert Trace.interior(n) == []
    assert Trace.interior(nil) == []
    assert Trace.interior("garbage") == []
  end

  test "interior_of/3 fetches a node by id then flattens" do
    root = %{kind: :run, status: :ok, name: "r", children: []}
    n = Recorder.record_node(Memory, "s", %{program: nil, memory: %{}, span_root: root}, nil)

    assert [%{depth: 0, kind: :run}] = Trace.interior_of(Memory, "s", n.id)
    assert Trace.interior_of(Memory, "s", "missing") == []
  end

  test "has_interior? reflects presence of span_root" do
    with_root =
      Recorder.record_node(
        Memory,
        "s",
        %{program: nil, memory: %{}, span_root: %{kind: :run, children: []}},
        nil
      )

    without = Recorder.record_node(Memory, "s", %{program: nil, memory: %{}}, with_root.id)

    rows = Trace.rows(Memory, "s")
    by_id = Map.new(rows, &{&1.node_id, &1.has_interior?})

    assert by_id[with_root.id] == true
    assert by_id[without.id] == false
  end
end
