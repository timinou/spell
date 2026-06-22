defmodule SpellAgent.Mesh.RecordTest do
  @moduledoc """
  Contracts for the mesh record (FEAT-008): store-assigned identity (NOT a content
  hash), the content_hash dedup FIELD, deterministic canonicalization, and the
  frozen-data invariant. These pin the corrections from the oracle review (P2.2):
  a record is keyed by a store seq, content_hash is only a dedup field, and no
  live term ever reaches the blackboard.
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Mesh.Record

  describe "new/4" do
    test "leaves seq nil — the store assigns the sequence, not the caller" do
      rec = Record.new(:finding, "region-1", %{about: "caller"}, author: "sess-a")
      assert rec.seq == nil
      assert rec.kind == :finding
      assert rec.region == "region-1"
      assert rec.author == "sess-a"
      assert is_integer(rec.t)
    end

    test "stamps a content_hash field (for dedup), distinct from any store key" do
      rec = Record.new(:finding, "region-1", %{about: "caller"})
      assert is_binary(rec.content_hash)
      assert String.length(rec.content_hash) == 64
    end

    test "rejects an unknown kind" do
      assert_raise ArgumentError, ~r/unknown mesh record kind/, fn ->
        Record.new(:bogus, "region-1", %{})
      end
    end

    test "carries optional parent / watermark / sealed" do
      rec = Record.new(:verdict, "r", %{q: 1}, watermark: 7, sealed: true, parent: "p")
      assert rec.watermark == 7
      assert rec.sealed == true
      assert rec.parent == "p"
    end
  end

  describe "frozen-data invariant" do
    test "raises on a pid in the payload" do
      assert_raise ArgumentError, ~r/frozen data.*pid/, fn ->
        Record.new(:finding, "r", %{owner: self()})
      end
    end

    test "raises on a function in the payload" do
      assert_raise ArgumentError, ~r/frozen data.*function/, fn ->
        Record.new(:finding, "r", %{f: fn -> :x end})
      end
    end

    test "raises on a pid nested in a list/tuple" do
      assert_raise ArgumentError, ~r/frozen data/, fn ->
        Record.new(:finding, "r", %{xs: [1, {:a, self()}]})
      end
    end

    test "accepts ordinary frozen data (maps, lists, atoms, numbers, binaries)" do
      payload = %{about: "caller", file: "lib/x.ex", line: 88, risk: :high, tags: ["a", "b"]}
      rec = Record.new(:finding, "r", payload)
      assert rec.payload == payload
    end
  end

  describe "content_hash/2 — determinism + dedup semantics" do
    test "is deterministic across calls for the same region + payload" do
      h1 = Record.content_hash("r", %{about: "x", n: 1})
      h2 = Record.content_hash("r", %{about: "x", n: 1})
      assert h1 == h2
    end

    test "atom and string key/value forms collapse to the same hash" do
      assert Record.content_hash("r", %{risk: :high}) ==
               Record.content_hash("r", %{"risk" => "high"})
    end

    test "map key ORDER does not change the hash (sorted canonical form)" do
      assert Record.content_hash("r", %{a: 1, b: 2}) ==
               Record.content_hash("r", %{b: 2, a: 1})
    end

    test "different region yields a different hash (region is namespaced in)" do
      refute Record.content_hash("r1", %{x: 1}) == Record.content_hash("r2", %{x: 1})
    end

    test "different payload yields a different hash" do
      refute Record.content_hash("r", %{x: 1}) == Record.content_hash("r", %{x: 2})
    end
  end

  describe "dedup_kinds/0" do
    test "only finding, goal, verdict dedup — claim and intention never collapse" do
      assert Record.dedup_kinds() == [:goal, :finding, :verdict]
      refute :claim in Record.dedup_kinds()
      refute :intention in Record.dedup_kinds()
    end
  end
end
