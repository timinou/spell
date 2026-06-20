defmodule SpellAgent.Hist.WindowTest do
  @moduledoc """
  Lossless-compaction contract (PLAN-001 W4, C6): windowing narrows the VIEW while
  the full log is retained; trimmed turns are recallable; distillation appends a
  summary + clearing mark without deleting the originals.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Mark, Recorder, Window}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp seed(n) do
    Enum.reduce(1..n, nil, fn i, parent ->
      node =
        Recorder.record_node(
          Memory,
          "s",
          %{program: "(def v#{i} #{i})", memory: %{}, result: "turn #{i} said thing #{i}"},
          parent && parent.id
        )

      {:ok, sess} = Store.fetch(Memory, {:session, "s"})
      Store.put(Memory, {:session, "s"}, %{sess | cursors: %{main: node.id}})
      node
    end)
  end

  test "window keeps initial + recent, trims the middle (from view only)" do
    seed(8)
    {:ok, %{shown: shown, trimmed: trimmed}} = Window.window(Memory, "s", keep_recent: 3, keep_initial: true)

    shown_seqs = Enum.map(shown, & &1.seq)
    # initial (1) + last three (6,7,8)
    assert shown_seqs == [1, 6, 7, 8]
    assert Enum.map(trimmed, & &1.seq) == [2, 3, 4, 5]

    # nothing deleted: all 8 still in the store
    assert length(Store.list(Memory, :node, "s")) == 8
  end

  test "recall pulls a trimmed node back by keyword" do
    seed(8)
    hits = Window.recall(Memory, "s", "thing 4", keep_recent: 3)
    assert Enum.map(hits, & &1.seq) == [4]
  end

  test "recall returns [] when the match is inside the kept window" do
    seed(8)
    # "thing 7" is in the recent window, not trimmed
    assert Window.recall(Memory, "s", "thing 7", keep_recent: 3) == []
  end

  test "distill appends a summary node + clearing mark, keeps originals" do
    seed(5)
    nodes = Store.list(Memory, :node, "s") |> Enum.sort_by(& &1.seq)
    ids = nodes |> Enum.slice(1, 3) |> Enum.map(& &1.id)

    {:ok, %{summary: summary, mark: mark}} = Window.distill(Memory, "s", ids, summary: "the middle bit")

    assert summary.say == "the middle bit"
    assert %Mark{kind: :clearing} = mark
    assert mark.node_id == summary.id
    # originals still present (5) + the summary (1)
    assert length(Store.list(Memory, :node, "s")) == 6
  end

  test "distill of an empty set is an explicit error" do
    assert {:error, :empty_distill} = Window.distill(Memory, "s", [])
  end
end
