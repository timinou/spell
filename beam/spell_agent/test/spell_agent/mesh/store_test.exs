defmodule SpellAgent.Mesh.StoreTest do
  @moduledoc """
  Contracts for the mesh store layer (FEAT-009), against an injected
  `Hist.Store.Memory` (the same body is the location-transparency contract for
  Khepri later). Pins the oracle corrections: store-assigned per-region seq is a
  total order (P2.1), claims with identical payload do NOT collapse while findings
  do (P2.2), and mesh writes never touch the Hist `{:hash, _}` node index (P2.2).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Mesh.Record
  alias SpellAgent.Mesh.Store, as: MeshStore

  setup do
    # Memory is the app-supervised named singleton; ensure it is up, then clear so
    # each test sees a fresh store (the mesh kinds share the one ETS table).
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)
    :ok
  end

  defp post(kind, region, payload, opts \\ []) do
    {:ok, rec} = MeshStore.put(Memory, Record.new(kind, region, payload, opts))
    rec
  end

  describe "per-region seq (the total order, P2.1)" do
    test "put assigns a strictly increasing seq per region, starting at 1" do
      a = post(:finding, "r1", %{about: "a"})
      b = post(:finding, "r1", %{about: "b"})
      c = post(:finding, "r1", %{about: "c"})
      assert [a.seq, b.seq, c.seq] == [1, 2, 3]
    end

    test "seq is independent per region" do
      a = post(:finding, "rA", %{x: 1})
      b = post(:finding, "rB", %{x: 1})
      assert a.seq == 1
      assert b.seq == 1
    end

    test "region/2 returns records in ascending seq order" do
      post(:finding, "r", %{n: 1})
      post(:finding, "r", %{n: 2})
      seqs = MeshStore.region(Memory, "r") |> Enum.map(& &1.seq)
      assert seqs == Enum.sort(seqs)
    end
  end

  describe "dedup semantics (P2.2)" do
    test "two identical-payload FINDINGS index under one content hash" do
      r1 = post(:finding, "r", %{about: "dup"})
      r2 = post(:finding, "r", %{about: "dup"})
      # Both are distinct records (distinct seq) but share the content index entry.
      assert r1.seq != r2.seq
      {:ok, seqs} = Store.fetch(Memory, {:mesh_hash, "r", r1.content_hash})
      assert Enum.sort(seqs) == Enum.sort([r1.seq, r2.seq])
    end

    test "two identical-payload CLAIMS do NOT dedup — both coexist for arbitration" do
      c1 = post(:claim, "r", %{work: "W"})
      c2 = post(:claim, "r", %{work: "W"})
      assert c1.seq != c2.seq
      # claim is not a dedup kind: no content index entry written.
      assert Store.fetch(Memory, {:mesh_hash, "r", c1.content_hash}) == :error
      assert length(MeshStore.claims_for(Memory, "r", "W")) == 2
    end

    test "mesh writes NEVER touch the Hist {:hash, _} node index" do
      post(:finding, "r", %{about: "x"})
      assert Store.list(Memory, :node) == []
      # the Hist hash kind is untouched by mesh puts
      assert Memory.fetch({:hash, "anything"}) == :error
    end
  end

  describe "by_match / by_kind / claims_for" do
    test "by_match filters by kind and where (atom/string tolerant)" do
      post(:finding, "r", %{about: "caller", risk: :high})
      post(:finding, "r", %{about: "caller", risk: :low})
      hits = MeshStore.by_match(Memory, "r", %{kind: :finding, where: %{risk: :high}})
      assert length(hits) == 1
      assert hd(hits).payload.risk == :high
    end

    test "by_kind selects one kind" do
      post(:goal, "r", %{objective: "o"})
      post(:finding, "r", %{about: "a"})
      assert length(MeshStore.by_kind(Memory, "r", :finding)) == 1
      assert length(MeshStore.by_kind(Memory, "r", :goal)) == 1
    end
  end

  describe "sealing (DC-9)" do
    test "a sealed region rejects further posts" do
      post(:finding, "r", %{a: 1})
      {:ok, _} = MeshStore.put(Memory, Record.new(:verdict, "r", %{done: true}, sealed: true))
      assert MeshStore.sealed?(Memory, "r")
      assert MeshStore.put(Memory, Record.new(:finding, "r", %{a: 2})) == {:error, :sealed}
    end
  end

  describe "max_seq/2" do
    test "is 0 for an empty region, else the highest seq" do
      assert MeshStore.max_seq(Memory, "empty") == 0
      post(:finding, "r", %{n: 1})
      post(:finding, "r", %{n: 2})
      assert MeshStore.max_seq(Memory, "r") == 2
    end
  end

  describe "concurrent seq assignment (the arbitration-critical contract)" do
    test "100 concurrent puts to one region get 100 DISTINCT seqs" do
      tasks =
        for i <- 1..100 do
          Task.async(fn -> post(:claim, "rc", %{work: "W", i: i}).seq end)
        end

      seqs = Enum.map(tasks, &Task.await/1)
      assert length(Enum.uniq(seqs)) == 100
      assert Enum.sort(seqs) == Enum.to_list(1..100)
    end
  end
end
