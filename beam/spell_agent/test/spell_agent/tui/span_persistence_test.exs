defmodule SpellAgent.Tui.SpanPersistenceTest do
  @moduledoc """
  FUP-003 — the span-persistence bridge: `Tui.Store.to_span_root/2` snapshots a
  live FLAT span forest into the nested `Hist.Node.span_root` shape, and
  `from_span_root/1` hydrates that flat forest back. So the inspector TUI renders a
  RECORDED run's interior exactly like a live one — drilling any past turn, not
  only the run in flight. No re-derivation from telemetry: the tree is read.

  Cassette-backed: a real run's span tree is captured once, persisted to a fixture
  inside a recorded Hist node, replayed into the store, and the hydration +
  `Hist.Spans` reads are asserted against the reloaded tree.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.Store
  alias SpellAgent.Tui.Store.Span
  alias SpellAgent.Hist.{Recorder, Spans}
  alias SpellAgent.Hist.Store, as: HistStore
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.HistCassette

  @prefix [:ptc_runner, :sub_agent]

  setup do
    {:ok, pid} = Store.start_link(name: nil)
    :ok = Store.attach(pid)
    HistStore.clear(Memory)
    %{store: pid}
  end

  defp emit(suffix, meta, meas \\ %{}), do: :telemetry.execute(@prefix ++ suffix, meas, meta)

  # Build a real forest: run -> (llm, tool -> nested run -> nested llm).
  defp seed_forest(pid) do
    emit([:run, :start], %{span_id: "run1", parent_span_id: nil, agent_name: "root"})
    emit([:turn, :start], %{span_id: "run1", turn: 1, program: "(work)"})
    emit([:llm, :start], %{span_id: "llm1", parent_span_id: "run1", model: "sonnet"})

    emit([:llm, :stop], %{span_id: "llm1", parent_span_id: "run1", response: "ok"}, %{
      input_tokens: 100,
      output_tokens: 20
    })

    emit([:tool, :start], %{span_id: "tool1", parent_span_id: "run1", tool_name: "sub_agent"})
    emit([:run, :start], %{span_id: "run2", parent_span_id: "tool1", agent_name: "child"})
    emit([:llm, :start], %{span_id: "llm2", parent_span_id: "run2", model: "haiku"})

    emit([:llm, :stop], %{span_id: "llm2", parent_span_id: "run2", response: "done"}, %{
      input_tokens: 10,
      output_tokens: 5
    })

    emit([:run, :stop], %{span_id: "run2", status: :ok, return: 42})

    emit([:tool, :stop], %{
      span_id: "tool1",
      parent_span_id: "run1",
      tool_name: "sub_agent",
      result: %{}
    })

    emit([:turn, :stop], %{span_id: "run1", turn: 1, program: "(work)", result_preview: "42"})
    emit([:run, :stop], %{span_id: "run1", status: :ok, return: 42})
    Store.spans(pid)
  end

  test "to_span_root snapshots the live forest into a nested tree", %{store: pid} do
    spans = seed_forest(pid)
    root = Store.to_span_root(spans, "run1")

    assert root.id == "run1"
    assert root.kind == :run
    # children oldest-first: llm1 then tool1
    assert Enum.map(root.children, & &1.id) == ["llm1", "tool1"]
    # nesting preserved: tool1 -> run2 -> llm2
    [_llm1, tool1] = root.children
    assert [%{id: "run2", children: [%{id: "llm2"}]}] = tool1.children
  end

  test "to_span_root returns nil for an absent root", %{store: pid} do
    spans = seed_forest(pid)
    assert Store.to_span_root(spans, "nope") == nil
  end

  test "ROUND-TRIP: from_span_root(to_span_root(forest)) reproduces the subtree", %{store: pid} do
    spans = seed_forest(pid)
    root = Store.to_span_root(spans, "run1")
    hydrated = Store.from_span_root(root)

    # Same span ids, same kinds, same parent links, same child ordering as the
    # live subtree rooted at run1.
    live_subtree_ids = spans |> Store.subtree("run1") |> Enum.map(& &1.id) |> Enum.sort()
    assert hydrated |> Map.keys() |> Enum.sort() == live_subtree_ids

    for id <- live_subtree_ids do
      assert hydrated[id].kind == spans[id].kind
      assert hydrated[id].parent_id == spans[id].parent_id
    end

    # children/2 yields the same oldest-first order on both forests.
    assert Enum.map(Store.children(hydrated, "run1"), & &1.id) ==
             Enum.map(Store.children(spans, "run1"), & &1.id)

    assert Enum.map(Store.subtree(hydrated, "run1"), & &1.id) ==
             Enum.map(Store.subtree(spans, "run1"), & &1.id)
  end

  test "CASSETTE: a recorded run's span tree persists to disk and rehydrates", %{store: pid} do
    spans = seed_forest(pid)
    root = Store.to_span_root(spans, "run1")

    # Record a Hist turn carrying the snapshotted span tree, via the cassette
    # (so it is serialized to a fixture and replayed from disk).
    turns = [
      %{
        program: "(work)",
        memory: %{},
        tool_calls: [],
        prints: [],
        raw_response: "r",
        span_root: root
      }
    ]

    %{nodes: [node]} = HistCassette.ensure("span_run", "spans", turns, Memory)

    # The persisted node carries the nested tree; Hist.Spans reads it WITHOUT any
    # live telemetry (the store forest is irrelevant here).
    flat = Spans.spans(node)
    assert Enum.map(flat, &span_id/1) == ["run1", "llm1", "tool1", "run2", "llm2"]
    assert Spans.cost(node) == %{input: 110, output: 25}

    # And the TUI bridge rehydrates the SAME flat forest from the persisted tree:
    # the inspector can drill a recorded run identically to a live one.
    rehydrated = Store.from_span_root(node.span_root)
    assert %Span{kind: :run, id: "run1"} = rehydrated["run1"]

    assert Enum.map(Store.subtree(rehydrated, "run1"), & &1.id) == [
             "run1",
             "llm1",
             "tool1",
             "run2",
             "llm2"
           ]

    # the nested sub-agent run survived the disk round-trip
    assert rehydrated["run2"].parent_id == "tool1"
  end

  test "from_span_root tolerates nil and string-keyed persisted maps" do
    assert Store.from_span_root(nil) == %{}

    # A persisted tree may come back string-keyed (e.g. via a JSON store).
    string_keyed = %{
      "id" => "r",
      "kind" => :run,
      "children" => [%{"id" => "c", "kind" => :tool, "children" => []}]
    }

    flat = Store.from_span_root(string_keyed)
    assert flat["r"].id == "r"
    assert flat["c"].parent_id == "r"
  end

  # span maps from Hist.Spans keep atom-or-string keys; read id either way.
  defp span_id(s), do: Map.get(s, :id) || Map.get(s, "id")
end
