defmodule SpellAgent.Hist.CrystallizeTest do
  @moduledoc """
  Contract for crystallizing history into durable memory (PLAN-001, C2).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Crystal, Crystallize, Recorder}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  @impl_store Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  test "slice_source concatenates node form_src in seq order and skips missing ids" do
    n1 = Recorder.record_node(@impl_store, "s1", %{program: "(def a 1)", memory: %{a: 1}}, nil)
    n2 = Recorder.record_node(@impl_store, "s1", %{program: "(def b 2)", memory: %{a: 1, b: 2}}, n1.id)
    n3 = Recorder.record_node(@impl_store, "s1", %{program: "(+ a b)", memory: %{a: 1, b: 2}}, n2.id)

    src = Crystallize.slice_source(@impl_store, "s1", [n3.id, "missing", n1.id, n2.id])

    assert src == "(do\n  (def a 1)\n  (def b 2)\n  (+ a b)\n)"
  end

  test "crystallize persists a crystal with the requested provenance" do
    n1 = Recorder.record_node(@impl_store, "s1", %{program: "(def a 1)", memory: %{a: 1}}, nil)
    n2 = Recorder.record_node(@impl_store, "s1", %{program: "(def b 2)", memory: %{a: 1, b: 2}}, n1.id)

    {:ok, %Crystal{} = crystal} =
      Crystallize.crystallize(@impl_store, "s1", [n1.id, n2.id], %{
        name: "double-def",
        signature: "() -> {:ok :int}",
        compile: {:source, "(do\n  (def a 1)\n  (def b 2)\n)"}
      })

    assert crystal.name == "double-def"
    assert crystal.signature == "() -> {:ok :int}"
    assert crystal.source == "(do\n  (def a 1)\n  (def b 2)\n)"
    assert crystal.origin == %{session: "s1", nodes: [n1.id, n2.id]}
    assert is_binary(crystal.metadata.compiled_at)
    assert crystal.metadata.tokens_used == 0
    assert crystal.metadata.turns == 2
    assert crystal.metadata.llm_model == nil

    assert {:ok, ^crystal} = Crystallize.get(@impl_store, crystal.id)
    assert [^crystal] = Crystallize.all(@impl_store)
  end

  test "crystallize with empty node_ids returns {:error, :empty_slice}" do
    assert Crystallize.crystallize(@impl_store, "s1", [], %{name: "empty"}) ==
             {:error, :empty_slice}
  end

  test "to_tool_source returns the crystal source" do
    crystal = %Crystal{id: "crystal-1", name: "x", source: "(return 1)"}
    assert Crystallize.to_tool_source(crystal) == "(return 1)"
  end
end
