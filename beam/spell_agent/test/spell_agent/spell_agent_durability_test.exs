defmodule SpellAgent.SpellAgentDurabilityTest do
  @moduledoc """
  PLAN-024 Wave 4 (FUP-009): `SpellAgent.maybe_enable_durability/1`'s exact
  CLI-flag semantics, extracted from `SpellAgent.tui/1` so this is testable
  without invoking the blocking, terminal-owning `tui/1` itself.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Tui.{Chord, KeymapRegistry, LayoutRegistry}

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)

    on_exit(fn ->
      restore_registry(LayoutRegistry)
      restore_registry(KeymapRegistry)
    end)

    :ok
  end

  defp restore_registry(mod) do
    :ok = Supervisor.terminate_child(SpellAgent.Supervisor, mod)
    {:ok, _pid} = Supervisor.restart_child(SpellAgent.Supervisor, mod)
  end

  describe "durable: false (the default) — a complete no-op" do
    test "neither registry is touched when :durable is absent" do
      assert :ok = SpellAgent.maybe_enable_durability([])
      refute LayoutRegistry.durable?()
      refute KeymapRegistry.durable?()
    end

    test "neither registry is touched when :durable is explicitly false" do
      assert :ok = SpellAgent.maybe_enable_durability(durable: false)
      refute LayoutRegistry.durable?()
      refute KeymapRegistry.durable?()
    end
  end

  describe "durable: true — both registries flip to durable" do
    test "both LayoutRegistry and KeymapRegistry report durable?/0 == true" do
      assert :ok = SpellAgent.maybe_enable_durability(durable: true)
      assert LayoutRegistry.durable?()
      assert KeymapRegistry.durable?()
    end
  end

  describe "durable: true, fresh: true — enabled but no rehydration" do
    test "a persisted layout is NOT adopted when fresh: true" do
      # Persist a customization under the DEFAULT durable name (what
      # maybe_enable_durability/1 uses when no :durable_name is given).
      Store.put(Memory, {:layout, "default"}, %{
        "type" => "paragraph",
        "slot" => "status",
        "text" => "SHOULD NOT APPEAR (fresh launch)"
      })

      assert :ok = SpellAgent.maybe_enable_durability(durable: true, fresh: true)

      assert LayoutRegistry.durable?()
      # Tree stays whatever it already was (untouched) — the point of `fresh` is
      # NOT rehydrating, not necessarily an empty tree.
      refute LayoutRegistry.tree()["text"] == "SHOULD NOT APPEAR (fresh launch)"
    end

    test "a persisted keymap binding is NOT adopted when fresh: true" do
      Store.put(Memory, {:keymap, "default"}, %{
        "bindings" => [%{"context" => "tree", "chord" => "z", "intent" => "span/expand"}],
        "reactions" => []
      })

      assert :ok = SpellAgent.maybe_enable_durability(durable: true, fresh: true)

      assert KeymapRegistry.durable?()
      assert KeymapRegistry.bindings(:tree) == []
    end
  end

  describe "durable: true, fresh: false (default) — rehydrates" do
    test "a persisted layout IS adopted" do
      Store.put(Memory, {:layout, "default"}, %{
        "type" => "paragraph",
        "slot" => "status",
        "text" => "REHYDRATED ON LAUNCH"
      })

      assert :ok = SpellAgent.maybe_enable_durability(durable: true)

      assert LayoutRegistry.tree()["text"] == "REHYDRATED ON LAUNCH"
    end

    test "a persisted keymap binding IS adopted" do
      Store.put(Memory, {:keymap, "default"}, %{
        "bindings" => [%{"context" => "tree", "chord" => "z", "intent" => "span/expand"}],
        "reactions" => []
      })

      assert :ok = SpellAgent.maybe_enable_durability(durable: true)

      assert KeymapRegistry.bindings(:tree) == [{Chord.parse("z"), :"span/expand"}]
    end
  end
end
