defmodule PtcRuntime.HandleStoreTest do
  @moduledoc """
  SPELL PATCH-3 (D-2): HandleStore + Handle unit tests.

  Pins the store's projection semantics, exec-scoped GC, re-parking of
  oversized projections, and the describe/meta surface — independent of the
  Peer/eval integration (which handle_offload_test.exs covers end-to-end).
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp.Handle
  alias PtcRunner.Lisp.HandleStore

  setup do
    # A dedicated, isolated store per test (the supervised singleton is shared).
    name = :"handle_store_#{System.unique_integer([:positive])}"
    start_supervised!({HandleStore, name: name})
    %{store: name}
  end

  # ~120 keys × 4KB strings → ~480KB serialized (external_size), comfortably
  # over the 256KB park/re-park threshold even though flat_size undercounts
  # off-heap binaries.
  defp big_map do
    for i <- 1..120, into: %{}, do: {"k#{i}", String.duplicate("x", 4_000)}
  end

  describe "put + handle metadata" do
    test "put returns a self-describing handle", %{store: store} do
      h = HandleStore.put(store, big_map(), "exec-1")
      assert Handle.handle?(h)
      assert h.store == store
      assert h.meta["shape"] == "map"
      assert h.meta["count"] == 120
      assert "k1" in h.meta["keys"]
      assert h.meta["bytes"] > 0
    end

    test "describe handles lists and scalars" do
      assert Handle.describe([1, 2, 3])["shape"] == "list"
      assert Handle.describe([1, 2, 3])["count"] == 3
      assert Handle.describe(42)["shape"] == "scalar"
    end
  end

  describe "projections run in-store and return only the slice" do
    setup %{store: store} do
      %{handle: HandleStore.put(store, big_map(), "exec-1")}
    end

    test "count", %{handle: h} do
      assert {:ok, 120} = HandleStore.project(h, {:count}, "exec-1")
    end

    test "get / get default", %{handle: h} do
      assert {:ok, val} = HandleStore.project(h, {:get, "k1", nil}, "exec-1")
      assert val == String.duplicate("x", 4_000)
      assert {:ok, :missing} = HandleStore.project(h, {:get, "nope", :missing}, "exec-1")
    end

    test "keys / select-keys / contains?", %{handle: h} do
      assert {:ok, keys} = HandleStore.project(h, {:keys}, "exec-1")
      assert "k1" in keys
      assert {:ok, sub} = HandleStore.project(h, {:select_keys, ["k1", "k2"]}, "exec-1")
      assert map_size(sub) == 2
      assert {:ok, true} = HandleStore.project(h, {:contains?, "k1"}, "exec-1")
      assert {:ok, false} = HandleStore.project(h, {:contains?, "zzz"}, "exec-1")
    end

    test "take / nth / first over a parked list", %{store: store} do
      list = Enum.to_list(1..1000)
      h = HandleStore.put(store, list, "exec-1")
      assert {:ok, [1, 2, 3]} = HandleStore.project(h, {:take, 3}, "exec-1")
      assert {:ok, 1} = HandleStore.project(h, {:first}, "exec-1")
      assert {:ok, 6} = HandleStore.project(h, {:nth, 5, nil}, "exec-1")
      assert {:ok, :dflt} = HandleStore.project(h, {:nth, 9999, :dflt}, "exec-1")
    end
  end

  describe "oversized projection re-parks as a nested handle" do
    test "get of a fat sub-value returns a handle, not the raw term", %{store: store} do
      # Outer map has a single key whose value is itself huge.
      fat = %{"payload" => big_map()}
      h = HandleStore.put(store, fat, "exec-1")
      assert {:ok, inner} = HandleStore.project(h, {:get, "payload", nil}, "exec-1")
      assert Handle.handle?(inner), "an oversized projection must re-park"
      # And the nested handle still projects.
      assert {:ok, 120} = HandleStore.project(inner, {:count}, "exec-1")
    end
  end

  describe "exec-scoped GC" do
    test "release drops every term for that exec_id; projecting is then stale", %{store: store} do
      h = HandleStore.put(store, big_map(), "exec-doomed")
      assert {:ok, 120} = HandleStore.project(h, {:count}, "exec-doomed")

      HandleStore.release(store, "exec-doomed")

      assert {:error, :stale_handle} = HandleStore.project(h, {:count}, "exec-doomed")
      assert {:error, :stale_handle} = HandleStore.realize(h)
    end

    test "release is bucket-scoped: other execs survive", %{store: store} do
      a = HandleStore.put(store, big_map(), "exec-a")
      b = HandleStore.put(store, big_map(), "exec-b")

      HandleStore.release(store, "exec-a")

      assert {:error, :stale_handle} = HandleStore.project(a, {:count}, "exec-a")
      assert {:ok, 120} = HandleStore.project(b, {:count}, "exec-b")
    end

    test "release is idempotent", %{store: store} do
      assert :ok = HandleStore.release(store, "never-existed")
      assert :ok = HandleStore.release(store, "never-existed")
    end
  end

  describe "realize" do
    test "returns the full parked term", %{store: store} do
      m = big_map()
      h = HandleStore.put(store, m, "exec-1")
      assert {:ok, ^m} = HandleStore.realize(h)
    end
  end
end
