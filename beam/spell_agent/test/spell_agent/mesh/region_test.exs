defmodule SpellAgent.Mesh.RegionTest do
  @moduledoc """
  Contracts for region minting (FEAT-008): Fork-A isolation by unforgeable nonce,
  Fork-B rendezvous by structured-key/slug, the natural-language rejection (DC-4),
  and the write-capability predicate.
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Mesh.Region

  describe "fork_a/2 — isolated, unforgeable" do
    test "yields a distinct id on every call (the nonce) even for identical inputs" do
      a = Region.fork_a("rank risk", "sess-parent")
      b = Region.fork_a("rank risk", "sess-parent")
      refute a == b
    end

    test "returns a non-empty hex id" do
      id = Region.fork_a("g", "p")
      assert is_binary(id)
      assert String.match?(id, ~r/^[0-9a-f]+$/)
    end
  end

  describe "fork_b/1 — rendezvous, deterministic" do
    test "an explicit slug is STABLE across calls (independent sessions meet)" do
      assert Region.fork_b({:slug, "ship-feature-x"}) == Region.fork_b({:slug, "ship-feature-x"})
    end

    test "a structured key is stable and order-insensitive" do
      assert Region.fork_b({:structured, %{pr: 42, repo: "spell"}}) ==
               Region.fork_b({:structured, %{repo: "spell", pr: 42}})
    end

    test "distinct slugs / structured keys yield distinct regions" do
      refute Region.fork_b({:slug, "a"}) == Region.fork_b({:slug, "b"})
      refute Region.fork_b({:structured, %{pr: 1}}) == Region.fork_b({:structured, %{pr: 2}})
    end

    test "slug and structured namespaces do not collide" do
      refute Region.fork_b({:slug, "42"}) == Region.fork_b({:structured, %{pr: 42}})
    end

    test "REJECTS a bare natural-language string (DC-4)" do
      assert_raise ArgumentError, ~r/natural-language/, fn ->
        Region.fork_b("ship feature X")
      end
    end

    test "rejects an empty slug and a malformed key" do
      assert_raise ArgumentError, fn -> Region.fork_b({:slug, ""}) end
      assert_raise ArgumentError, fn -> Region.fork_b({:weird, 1}) end
    end
  end

  describe "write_cap?/2" do
    test "true when the held id matches the region" do
      assert Region.write_cap?("r1", "r1")
    end

    test "true when the region is in a held list" do
      assert Region.write_cap?("r2", ["r1", "r2"])
    end

    test "false for a non-held region or nil" do
      refute Region.write_cap?("r3", ["r1", "r2"])
      refute Region.write_cap?("r3", nil)
    end
  end
end
