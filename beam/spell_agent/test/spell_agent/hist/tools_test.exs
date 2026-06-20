defmodule SpellAgent.Hist.ToolsTest do
  @moduledoc """
  Contract for the durable tool lifecycle (PLAN-001, C3).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Recorder, Tools}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  @impl_store Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  test "inventory reports authored tools with call and error counts" do
    Recorder.record_node(@impl_store, "s1", %{
      program: ~S|(tool/define-tool {:name "blast-radius" :source "(...)"})|,
      memory: %{},
      result: "authored blast-radius",
      tool_calls: [
        %{name: "define-tool", args: %{name: "blast-radius"}},
        %{name: "blast-radius", args: %{sym: "foo"}, result: %{hits: [1, 2]}},
        %{name: "blast-radius", args: %{sym: "bar"}, result: {:error, :timeout}}
      ]
    }, nil)

    [entry] = Tools.inventory(@impl_store, "s1")

    assert entry.name == "blast-radius"
    assert entry.calls == 2
    assert entry.errors == 1
    assert entry.source == nil
    assert entry.params == nil
    assert entry.doc == nil
    assert is_binary(entry.defined_node)
  end

  test "inventory skips sees that are not authored tools" do
    Recorder.record_node(@impl_store, "s1", %{
      program: ~S|(tool/find {:target "src"})|,
      memory: %{},
      result: nil,
      tools_defined: [],
      tool_calls: [
        %{name: "find", args: %{target: "src"}, result: []}
      ]
    }, nil)

    assert Tools.inventory(@impl_store, "s1") == []
  end

  test "promote_from persists a durable ToolDef and durable/1 lists it" do
    tool =
      Tools.promote_from(@impl_store, %{
        name: "blast-radius",
        source: ~S|(tool/find {:target (str data/sym " def->")})|,
        params: [:sym],
        doc: "Find callers.",
        session: "s1",
        node_id: "n1"
      })

    assert tool.name == "blast-radius"
    assert tool.scope == :durable
    assert tool.origin == %{session: "s1", node_id: "n1"}

    assert [^tool] = Tools.durable(@impl_store)
    assert {:ok, ^tool} = Store.fetch(@impl_store, {:tool, "blast-radius"})
  end

  test "prune removes a durable tool" do
    Tools.promote_from(@impl_store, %{name: "x", source: "(def x 1)"})
    assert length(Tools.durable(@impl_store)) == 1

    :ok = Tools.prune(@impl_store, "x")
    assert Tools.durable(@impl_store) == []
    assert Store.fetch(@impl_store, {:tool, "x"}) == :error
  end
end
