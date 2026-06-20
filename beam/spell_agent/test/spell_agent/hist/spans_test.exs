defmodule SpellAgent.Hist.SpansTest do
  @moduledoc """
  Spans contract (PLAN-001 C5): pure readers over a persisted span subtree.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Recorder, Spans}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  @impl_store Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp sample_root do
    %{
      id: "run-1",
      kind: :run,
      children: [
        %{
          id: "tool-1",
          kind: :tool,
          name: "find",
          tokens: %{input: 10, output: 5},
          children: [],
          meta: %{tool_name: "find"}
        },
        %{
          id: "llm-1",
          kind: :llm,
          tokens: %{input: 100, output: 20},
          children: []
        }
      ],
      tokens: %{input: 1, output: 0}
    }
  end

  test "spans/1 flattens a nested subtree (DFS)" do
    root = sample_root()
    flat = Spans.spans(root)
    assert length(flat) == 3
    assert Enum.map(flat, & &1.id) == ["run-1", "tool-1", "llm-1"]
  end

  test "spans/1 accepts a Node and tolerates nil span_root" do
    node = Recorder.record_node(@impl_store, "s1", %{program: "1", memory: %{}, span_root: sample_root()}, nil)
    assert length(Spans.spans(node)) == 3

    empty = Recorder.record_node(@impl_store, "s1", %{program: "2", memory: %{}}, node.id)
    assert Spans.spans(empty) == []
  end

  test "cost/1 sums input/output tokens" do
    assert %{input: 111, output: 25} = Spans.cost(sample_root())
  end

  test "cost/1 handles %{tokens: n} shape" do
    root = %{
      id: "run-2",
      kind: :run,
      children: [%{id: "tool-2", kind: :tool, name: "edit", tokens: %{tokens: 7}}],
      tokens: %{input: 3, output: 1}
    }

    assert %{input: 10, output: 1} = Spans.cost(root)
  end

  test "cost/1 is nil-safe" do
    assert %{input: 0, output: 0} = Spans.cost(nil)
  end

  test "trace/3 finds tool spans by name across session nodes" do
    root = sample_root()

    n1 =
      Recorder.record_node(@impl_store, "s1", %{
        program: "1",
        memory: %{},
        span_root: root
      }, nil)

    _n2 =
      Recorder.record_node(@impl_store, "s1", %{
        program: "2",
        memory: %{},
        span_root: %{
          id: "tool-2",
          kind: :tool,
          name: "edit",
          children: []
        }
      }, n1.id)

    hits = Spans.trace(@impl_store, "s1", "find")
    assert length(hits) == 1
    assert [%{id: "tool-1", node_id: nid, node_seq: seq}] = hits
    assert nid == n1.id
    assert seq == n1.seq

    assert [%{id: "tool-2"}] = Spans.trace(@impl_store, "s1", "edit")
    assert [] = Spans.trace(@impl_store, "s1", "missing")
  end

  test "trace/3 reads tool name from meta" do
    root = %{
      id: "run-3",
      kind: :run,
      children: [%{id: "tool-3", kind: :tool, meta: %{"tool_name" => "find"}}]
    }

    Recorder.record_node(@impl_store, "s1", %{program: "1", memory: %{}, span_root: root}, nil)
    assert [%{id: "tool-3"}] = Spans.trace(@impl_store, "s1", "find")
  end
end
