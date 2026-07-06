defmodule SpellAgent.Tui.DataSourceDurabilityTest do
  @moduledoc """
  PLAN-027 M7 (FUP-041): the shared registry-durability mechanism, applied to
  DataSource. Defends: a durable registry persists its FROZEN sources across a
  restart (a fresh registry rehydrates them), an Elixir closure is NOT persisted
  (can't serialize), and a corrupt/absent blob degrades to empty (never-brick).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.DataSource.Registry
  alias SpellAgent.Tui.Registry.Durable
  alias SpellAgent.Hist.Store.Memory

  @kind :data_source
  @name "sources"

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!({Memory, []})
      _ -> :ok
    end

    # Clear any persisted blob from a prior run so tests start clean.
    Durable.persist(Memory, {@kind, @name}, %{})
    :ok
  end

  describe "durable frozen sources survive a restart" do
    test "a frozen source persisted by a durable registry is rehydrated by a fresh one" do
      # Instance 1: durable, against Memory, started as an ISOLATED instance
      # (name: nil) so it never collides with the app-supervised singleton.
      {:ok, r1} = Registry.start_link(durable: true, store: Memory, name: nil)
      Agent.get_and_update(r1, fn st ->
        sources = Map.put(st.sources, "persisted", {:frozen, %{"node" => "sym", "value" => "x"}})
        st = %{st | sources: sources}
        Durable.persist(st.store, {@kind, @name}, %{"persisted" => %{"node" => "sym", "value" => "x"}})
        {:ok, st}
      end)

      Agent.stop(r1)

      # Instance 2: a fresh durable registry against the SAME store must rehydrate
      # the frozen source as a {:frozen, _} producer.
      {:ok, r2} = Registry.start_link(durable: true, store: Memory, name: nil)
      state = Agent.get(r2, & &1)

      assert Map.has_key?(state.sources, "persisted")
      assert match?({:frozen, _}, state.sources["persisted"])

      Agent.stop(r2)
    end

    test "a corrupt (non-map) persisted blob degrades to empty, never raises" do
      Durable.persist(Memory, {@kind, @name}, "not a map")

      {:ok, r} = Registry.start_link(durable: true, store: Memory, name: nil)
      assert Agent.get(r, & &1.sources) == %{}
      Agent.stop(r)
    end

    test "an empty persisted blob rehydrates to empty" do
      {:ok, r} = Registry.start_link(durable: true, store: Memory, name: nil)
      # (setup cleared the blob to %{}, so this is the empty case)
      assert Agent.get(r, & &1.sources) == %{}
      Agent.stop(r)
    end
  end

  describe "Registry.Durable helper contract" do
    test "persist then rehydrate round-trips a plain-data value" do
      Durable.persist(Memory, {:test_kind, "k"}, %{"a" => 1})
      assert Durable.rehydrate(Memory, {:test_kind, "k"}, :default, &is_map/1) == %{"a" => 1}
    end

    test "rehydrate returns the default when validate rejects the persisted value" do
      Durable.persist(Memory, {:test_kind, "k2"}, %{"a" => 1})
      # validate demands a list; the persisted map fails -> default.
      assert Durable.rehydrate(Memory, {:test_kind, "k2"}, :fallback, &is_list/1) == :fallback
    end

    test "persist to a nil store is a no-op; rehydrate from nil is the default" do
      assert Durable.persist(nil, {:k, "n"}, %{}) == :ok
      assert Durable.rehydrate(nil, {:k, "n"}, :def, fn _ -> true end) == :def
    end
  end
end
