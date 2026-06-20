defmodule SpellAgent.Hist.Store.KhepriTest do
  @moduledoc """
  The durable store must satisfy the SAME `Hist.Store` contract as the Memory impl
  (PLAN-001 W4) — round-trip, delete, and session-scoped `list/2` — but against a
  real on-disk Khepri instance. Tagged `:khepri`; run with `--include khepri`
  (excluded by default because it boots a Ra system + writes to disk).
  """
  use ExUnit.Case, async: false

  @moduletag :khepri

  alias SpellAgent.Hist.{Node, Session, ToolDef}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Khepri

  setup_all do
    # Khepri boots the default `khepri` Ra system bound to ONE data dir; starting
    # it repeatedly with different dirs in the same BEAM yields {:error, :enoent}.
    # So boot once for the whole module, clear between tests.
    dir = Path.join(System.tmp_dir!(), "hist_khepri_#{:erlang.unique_integer([:positive])}")
    {:ok, _} = Khepri.start(dir)

    on_exit(fn ->
      Khepri.stop()
      File.rm_rf(dir)
    end)

    %{dir: dir}
  end

  setup do
    Store.clear(Khepri)
    :ok
  end

  test "put/fetch round-trips a node verbatim through Khepri" do
    node = %Node{id: "n1", session: "s1", seq: 1, say: "hi", binds: %{x: 1}}
    :ok = Store.put(Khepri, {:node, "s1", "n1"}, node)
    assert {:ok, ^node} = Store.fetch(Khepri, {:node, "s1", "n1"})
  end

  test "fetch of an absent key is :error" do
    assert :error = Store.fetch(Khepri, {:node, "s1", "ghost"})
  end

  test "delete removes a key" do
    Store.put(Khepri, {:session, "s1"}, %Session{id: "s1"})
    Store.delete(Khepri, {:session, "s1"})
    assert :error = Store.fetch(Khepri, {:session, "s1"})
  end

  test "list(:node, sid) is session-scoped" do
    Store.put(Khepri, {:node, "s1", "n1"}, %Node{id: "n1", session: "s1", seq: 1})
    Store.put(Khepri, {:node, "s1", "n2"}, %Node{id: "n2", session: "s1", seq: 2})
    Store.put(Khepri, {:node, "s2", "n3"}, %Node{id: "n3", session: "s2", seq: 1})

    assert Khepri |> Store.list(:node, "s1") |> Enum.map(& &1.id) |> Enum.sort() == ["n1", "n2"]
    assert Khepri |> Store.list(:node, nil) |> length() == 3
  end

  test "session-global kinds ignore session scope" do
    Store.put(Khepri, {:tool, "blast"}, %ToolDef{name: "blast", source: "(...)"})
    assert [%ToolDef{name: "blast"}] = Store.list(Khepri, :tool, "anything")
  end

  test "durability: a value survives a stop/start cycle on the same dir", %{dir: dir} do
    Store.put(Khepri, {:crystal, "c1"}, %SpellAgent.Hist.Crystal{id: "c1", name: "hot", source: "(x)"})
    # force the write to disk, then cycle the store on the SAME data dir
    :ok = :khepri.fence(:spell_hist)
    Khepri.stop()
    {:ok, _} = Khepri.start(dir)

    assert {:ok, %{id: "c1"}} = Store.fetch(Khepri, {:crystal, "c1"})
  end
end
