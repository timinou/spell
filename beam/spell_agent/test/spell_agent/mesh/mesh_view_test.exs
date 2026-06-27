defmodule SpellAgent.Mesh.MeshViewTest do
  @moduledoc """
  Contracts for the mesh inspector's data + formatting surface (FEAT-014/015,
  PLAN-019 M4): Mesh.Store.regions/1 (the region index), Mesh.MeshView text
  renderers, and the fold path the stdout task drives. The pure formatters are the
  shared rendering both the CLI and a future TUI pane consume.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Mesh.{MeshView, Namespace, Record}
  alias SpellAgent.Mesh.Store, as: MeshStore

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)
    :ok
  end

  defp post(region, kind, payload, author \\ "s1") do
    {:ok, _} = MeshStore.put(Memory, Record.new(kind, region, payload, author: author))
  end

  describe "Store.regions/1 (the index)" do
    test "enumerates regions with per-kind counts", _ do
      post("r1", :finding, %{"n" => 1})
      post("r1", :finding, %{"n" => 2})
      post("r1", :goal, %{"o" => "x"})
      post("r2", :finding, %{"n" => 3})

      regions = MeshStore.regions(Memory)

      assert length(regions) == 2
      r1 = Enum.find(regions, &(&1.region == "r1"))
      assert r1.count == 3
      assert r1.kinds[:finding] == 2
      assert r1.kinds[:goal] == 1
    end

    test "empty store -> no regions", _ do
      assert MeshStore.regions(Memory) == []
    end
  end

  describe "MeshView.regions_text/1" do
    test "renders the region index with counts" do
      text = MeshView.regions_text([%{region: "r1", count: 3, kinds: %{finding: 2, goal: 1}}])
      assert text =~ "REGIONS (1)"
      assert text =~ "r1"
      assert text =~ "finding:2"
      assert text =~ "goal:1"
    end

    test "empty index renders a clear message" do
      assert MeshView.regions_text([]) =~ "no mesh regions"
    end
  end

  describe "MeshView.board_text/2" do
    test "renders a region's records, seq-ordered, with compact payloads" do
      post("r1", :finding, %{"status" => "done"})
      records = MeshStore.region(Memory, "r1")

      text = MeshView.board_text("r1", records)
      assert text =~ "REGION r1"
      assert text =~ "finding"
      assert text =~ "status="
    end

    test "an empty region renders (empty)" do
      assert MeshView.board_text("r1", []) =~ "(empty)"
    end
  end

  describe "MeshView.fold_text/1" do
    test "renders scalar, list, and map folds" do
      assert MeshView.fold_text(3) == "3\n"
      assert MeshView.fold_text("x") == "x\n"
      assert MeshView.fold_text([1, 2]) =~ "1"
      assert MeshView.fold_text(%{"a" => 1}) =~ "a: 1"
    end
  end

  describe "fold via the namespace (what the task drives)" do
    test "a count fold over findings returns the count" do
      post("r1", :finding, %{"n" => 1})
      post("r1", :finding, %{"n" => 2})
      verbs = Namespace.tools(Memory, "cli", "r1", held: ["r1"])

      assert verbs["black/fold"].(%{"over" => "finding", "reduce" => "count"}) == 2
    end

    test "a group-by fold buckets by a field" do
      post("r1", :finding, %{"risk" => "high"})
      post("r1", :finding, %{"risk" => "low"})
      post("r1", :finding, %{"risk" => "high"})
      verbs = Namespace.tools(Memory, "cli", "r1", held: ["r1"])

      grouped = verbs["black/fold"].(%{"over" => "finding", "reduce" => "group-by", "field" => "risk"})
      assert map_size(grouped) == 2
      assert length(grouped["high"]) == 2
      assert length(grouped["low"]) == 1
    end
  end
end
