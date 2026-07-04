defmodule SpellAgent.Tui.KeymapRegistryDurabilityTest do
  @moduledoc """
  Durability contracts for `KeymapRegistry` (PLAN-024 Wave 4 / FUP-009).

  Mirrors `test/tool_registry_durability_test.exs` / `layout_registry_durability_test.exs`'s
  structure: the registry is a NAMED singleton (app-supervised), so start-time
  rehydration is exercised through the registry's OWN public projection
  function (`rehydrate_into/3`), while the live mirror/reset paths are
  exercised via `Supervisor.terminate_child/2` + `restart_child/2` (never a raw
  `GenServer.stop/1`, which would race the `:one_for_one` supervisor's own
  auto-restart with the ORIGINAL non-durable boot opts).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Tui.{Chord, KeymapRegistry}

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)
    :ok
  end

  defp with_durable_registry(durable_name, fun) do
    :ok = Supervisor.terminate_child(SpellAgent.Supervisor, KeymapRegistry)
    {:ok, _pid} = Supervisor.restart_child(SpellAgent.Supervisor, KeymapRegistry)
    KeymapRegistry.enable_durability(store: Memory, durable_name: durable_name, rehydrate: false)

    try do
      fun.()
    after
      :ok = Supervisor.terminate_child(SpellAgent.Supervisor, KeymapRegistry)
      {:ok, _pid} = Supervisor.restart_child(SpellAgent.Supervisor, KeymapRegistry)
    end
  end

  describe "rehydration (registry as a projection of the store)" do
    test "rehydrate_into/3 recovers persisted bindings + reactions from a PRIOR session" do
      snapshot = %{
        "bindings" => [%{"context" => "tree", "chord" => "C-l", "intent" => "span/expand"}],
        "reactions" => [%{"context" => "tree", "intent" => "span/expand", "source" => "(harness/expand {})"}]
      }

      Store.put(Memory, {:keymap, "rehydrate-test"}, snapshot)

      base = %{bindings: %{}, reactions: %{}, intents: MapSet.new()}
      result = KeymapRegistry.rehydrate_into(base, Memory, "rehydrate-test")

      assert result.bindings == %{{:tree, Chord.parse("C-l")} => :"span/expand"}
      assert result.reactions == %{{:tree, :"span/expand"} => "(harness/expand {})"}
    end

    test "rehydrate_into/3 falls back to the base state on an absent key" do
      base = %{bindings: %{}, reactions: %{}, intents: MapSet.new()}
      name = "never-persisted-#{System.unique_integer([:positive])}"
      assert KeymapRegistry.rehydrate_into(base, Memory, name) == base
    end

    test "rehydrate_into/3 skips a malformed binding entry rather than crashing (one bad record isn't fatal)" do
      snapshot = %{
        "bindings" => [
          %{"context" => "tree", "chord" => "C-l", "intent" => "span/expand"},
          %{"context" => "totally-never-a-real-atom-xyz-123", "chord" => "x", "intent" => "span/expand"},
          "not even a map"
        ],
        "reactions" => []
      }

      Store.put(Memory, {:keymap, "corrupt-test"}, snapshot)

      base = %{bindings: %{}, reactions: %{}, intents: MapSet.new()}
      result = KeymapRegistry.rehydrate_into(base, Memory, "corrupt-test")

      # The good entry survived; the corrupt ones were skipped (never crashed).
      assert result.bindings == %{{:tree, Chord.parse("C-l")} => :"span/expand"}
    end

    test "rehydrate_into/3 never interns a NEW atom for an unrecognized context" do
      uniq_ctx = "never-declared-context-#{System.unique_integer([:positive])}"

      snapshot = %{
        "bindings" => [%{"context" => uniq_ctx, "chord" => "x", "intent" => "span/expand"}],
        "reactions" => []
      }

      Store.put(Memory, {:keymap, "atom-safety-test"}, snapshot)

      base = %{bindings: %{}, reactions: %{}, intents: MapSet.new()}
      _result = KeymapRegistry.rehydrate_into(base, Memory, "atom-safety-test")

      assert_raise ArgumentError, fn -> String.to_existing_atom(uniq_ctx) end
    end

    test "rehydrate_into/3 rejects a malformed intent name (shape gate applies on rehydrate too)" do
      snapshot = %{
        "bindings" => [%{"context" => "tree", "chord" => "x", "intent" => "Not A Valid Intent!!"}],
        "reactions" => []
      }

      Store.put(Memory, {:keymap, "bad-intent-test"}, snapshot)

      base = %{bindings: %{}, reactions: %{}, intents: MapSet.new()}
      result = KeymapRegistry.rehydrate_into(base, Memory, "bad-intent-test")

      assert result.bindings == %{}
    end
  end

  describe "mirroring to the durable store" do
    test "bind/3 persists to {:keymap, name}" do
      with_durable_registry("mirror-test", fn ->
        :ok = KeymapRegistry.bind(:tree, Chord.parse("g"), :"span/goto")

        assert {:ok, snapshot} = Store.fetch(Memory, {:keymap, "mirror-test"})
        assert %{"context" => "tree", "chord" => "g", "intent" => "span/goto"} in snapshot["bindings"]
      end)
    end

    test "put_reaction/3 persists to {:keymap, name}" do
      with_durable_registry("mirror-reaction-test", fn ->
        :ok = KeymapRegistry.put_reaction(:tree, :"span/goto", "(harness/expand {})")

        assert {:ok, snapshot} = Store.fetch(Memory, {:keymap, "mirror-reaction-test"})
        assert %{"context" => "tree", "intent" => "span/goto", "source" => "(harness/expand {})"} in snapshot["reactions"]
      end)
    end

    test "the FULL end-to-end acceptance shape: bind + define-reaction, simulate a relaunch, both survive" do
      name = "acceptance-#{System.unique_integer([:positive])}"

      with_durable_registry(name, fn ->
        :ok = KeymapRegistry.bind(:tree, Chord.parse("g"), :"span/goto")
        :ok = KeymapRegistry.put_reaction(:tree, :"span/goto", "(harness/expand {})")
      end)

      base = %{bindings: %{}, reactions: %{}, intents: MapSet.new()}
      rehydrated = KeymapRegistry.rehydrate_into(base, Memory, name)

      assert rehydrated.bindings == %{{:tree, Chord.parse("g")} => :"span/goto"}
      assert rehydrated.reactions == %{{:tree, :"span/goto"} => "(harness/expand {})"}
    end

    test "unbind/2 removes the binding from the persisted mirror too" do
      with_durable_registry("unbind-test", fn ->
        :ok = KeymapRegistry.bind(:tree, Chord.parse("g"), :"span/goto")
        :ok = KeymapRegistry.unbind(:tree, Chord.parse("g"))

        assert {:ok, snapshot} = Store.fetch(Memory, {:keymap, "unbind-test"})
        assert snapshot["bindings"] == []
      end)
    end

    test "clear_context/1 removes only that context from the persisted mirror" do
      with_durable_registry("clear-context-test", fn ->
        :ok = KeymapRegistry.bind(:tree, Chord.parse("g"), :"span/goto")
        :ok = KeymapRegistry.bind(:prompt, Chord.parse("h"), :"span/goto")
        :ok = KeymapRegistry.clear_context(:tree)

        {:ok, snapshot} = Store.fetch(Memory, {:keymap, "clear-context-test"})
        contexts = Enum.map(snapshot["bindings"], & &1["context"])
        assert contexts == ["prompt"]
      end)
    end

    test ":hole_affordance context (PLAN-024 Wave 3, a DERIVED per-navigation context) is NEVER persisted" do
      with_durable_registry("hole-affordance-exclusion-test", fn ->
        :ok = KeymapRegistry.bind(:hole_affordance, Chord.parse("1"), :"hole/fill-choice-0")
        :ok = KeymapRegistry.put_reaction(:hole_affordance, :"hole/fill-choice-0", "(black/post {})")

        assert :error = Store.fetch(Memory, {:keymap, "hole-affordance-exclusion-test"})
      end)
    end

    test "reset/0 persists the wipe (an empty snapshot), not the stale prior state" do
      with_durable_registry("reset-test", fn ->
        :ok = KeymapRegistry.bind(:tree, Chord.parse("g"), :"span/goto")
        :ok = KeymapRegistry.reset()

        assert {:ok, snapshot} = Store.fetch(Memory, {:keymap, "reset-test"})
        assert snapshot["bindings"] == []
        assert snapshot["reactions"] == []
      end)
    end
  end

  describe "a non-durable registry never touches the store" do
    test "bind/3 on the default (non-durable) singleton writes nothing to Memory" do
      case Process.whereis(KeymapRegistry) do
        nil -> start_supervised!(KeymapRegistry)
        _ -> KeymapRegistry.reset()
      end

      :ok = KeymapRegistry.bind(:tree, Chord.parse("g"), :"span/goto")
      assert Store.list(Memory, :keymap, nil) == []
    end
  end

  describe "durable?/0 introspection" do
    test "a plain (non-durable) registry reports durable?/0 == false" do
      case Process.whereis(KeymapRegistry) do
        nil -> start_supervised!(KeymapRegistry)
        _ -> :ok
      end

      refute KeymapRegistry.durable?()
    end

    test "a durable registry reports durable?/0 == true" do
      with_durable_registry("durable-flag-test", fn ->
        assert KeymapRegistry.durable?()
      end)
    end
  end
end
