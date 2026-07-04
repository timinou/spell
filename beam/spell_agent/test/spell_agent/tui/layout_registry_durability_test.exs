defmodule SpellAgent.Tui.LayoutRegistryDurabilityTest do
  @moduledoc """
  Durability contracts for `LayoutRegistry` (PLAN-024 Wave 4 / FUP-009).

  Mirrors `test/tool_registry_durability_test.exs`'s structure: the registry is
  a NAMED singleton (app-supervised), so start-time rehydration is exercised
  through the registry's OWN public projection function (`rehydrate/3`, the
  SAME code `start_link/1` and `enable_durability/1` call) against the shared
  Memory store, while the live mirror/reset/set paths are exercised through a
  SEPARATELY-NAMED registry instance started explicitly for this test file (so
  it never collides with the app-supervised singleton other test files share).

  Defends the FUP-009 acceptance criteria directly:
    * author a layout (`set/2`), the record persists to `{:layout, name}`;
    * a fresh registry rehydrates that layout via `rehydrate/3`;
    * a persisted slot that no longer materializes degrades to the native
      default (the SAME render-probe failure ladder `set/2` uses — never
      bricks mount);
    * a non-durable registry never touches the store at all;
    * `replace/1` (gaze re-tags, every keystroke) never persists — only
      agent-facing structural mutations (`set/2`, `reset/1`, `reset_all/0`,
      `update_path/3`) do.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Tui.{DefaultLayout, LayoutRegistry, Ui}

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)
    :ok
  end

  defp default_tree do
    DefaultLayout.tree(Ui.new(panes: [:tree, :detail], focus: :tree), ["tree", "detail"])
  end

  # `LayoutRegistry` is BOTH a named singleton (`start_link(name: __MODULE__)`,
  # so its public API — `set/2`, `tree/0`, … — always targets that one name) AND
  # a supervised child of `SpellAgent.Supervisor` under a `:one_for_one`
  # strategy. A raw `GenServer.stop/1` would race the supervisor's own restart
  # (which relaunches it with its ORIGINAL, non-durable boot opts) — so this
  # helper goes through `Supervisor.terminate_child/2` +
  # `Supervisor.restart_child/2` instead, which correctly coordinates with the
  # supervisor: terminate (no auto-restart mid-test), reconfigure via
  # `enable_durability/1` (the SAME runtime-toggle path `SpellAgent.tui/1` uses,
  # rather than fighting the supervisor's fixed child-spec args), exercise, then
  # restore to a plain non-durable instance for later test files in the same run.
  defp with_durable_registry(durable_name, fun) do
    :ok = Supervisor.terminate_child(SpellAgent.Supervisor, LayoutRegistry)
    {:ok, _pid} = Supervisor.restart_child(SpellAgent.Supervisor, LayoutRegistry)
    LayoutRegistry.seed_default(default_tree())
    LayoutRegistry.enable_durability(store: Memory, durable_name: durable_name, rehydrate: false)

    try do
      fun.()
    after
      :ok = Supervisor.terminate_child(SpellAgent.Supervisor, LayoutRegistry)
      {:ok, _pid} = Supervisor.restart_child(SpellAgent.Supervisor, LayoutRegistry)
      LayoutRegistry.seed_default(default_tree())
    end
  end

  describe "rehydration (registry as a projection of the store)" do
    test "rehydrate/3 recovers a persisted tree written by a PRIOR session" do
      persisted = %{
        "type" => "split",
        "dir" => "vertical",
        "slot" => "frame",
        "children" => [%{"type" => "paragraph", "slot" => "status", "text" => "FROM A PAST LIFE"}]
      }

      Store.put(Memory, {:layout, "rehydrate-test"}, persisted)

      result = LayoutRegistry.rehydrate(Memory, "rehydrate-test", default_tree())
      assert result == persisted
    end

    test "rehydrate/3 falls back to native_default on an absent key" do
      native = default_tree()
      assert LayoutRegistry.rehydrate(Memory, "never-persisted-#{System.unique_integer([:positive])}", native) == native
    end

    test "rehydrate/3 falls back to native_default when the persisted tree no longer VALIDATES (stale widget)" do
      bad_persisted = %{"type" => "no_such_widget_anymore", "slot" => "frame"}
      Store.put(Memory, {:layout, "stale-test"}, bad_persisted)

      native = default_tree()
      assert LayoutRegistry.rehydrate(Memory, "stale-test", native) == native
    end

    test "rehydrate/3 falls back to native_default for a non-map persisted value (corrupt record)" do
      Store.put(Memory, {:layout, "corrupt-test"}, "not a tree at all")

      native = default_tree()
      assert LayoutRegistry.rehydrate(Memory, "corrupt-test", native) == native
    end
  end

  describe "set/2 mirrors to the durable store, only when durable" do
    test "a slot shadow lands in {:layout, name} after set/2 on a durable registry" do
      with_durable_registry("mirror-test", fn ->
        assert :ok =
                 LayoutRegistry.set("status", %{
                   "type" => "paragraph",
                   "slot" => "status",
                   "text" => "PERSISTED"
                 })

        assert {:ok, persisted} = Store.fetch(Memory, {:layout, "mirror-test"})
        assert SpellAgent.Tui.Lens.at(persisted, "status")["text"] == "PERSISTED"
      end)
    end

    test "the FULL end-to-end acceptance shape: set, simulate a relaunch (rehydrate), the custom slot survives" do
      name = "acceptance-#{System.unique_integer([:positive])}"

      with_durable_registry(name, fn ->
        :ok =
          LayoutRegistry.set("status", %{
            "type" => "paragraph",
            "slot" => "status",
            "text" => "SURVIVED A RELAUNCH"
          })
      end)

      # Simulate the NEXT launch: a brand-new registry, durable, same store/name.
      rehydrated = LayoutRegistry.rehydrate(Memory, name, default_tree())
      assert SpellAgent.Tui.Lens.at(rehydrated, "status")["text"] == "SURVIVED A RELAUNCH"
    end

    test "reset/1 (undo a customization) persists the reverted default too" do
      name = "reset-test-#{System.unique_integer([:positive])}"

      with_durable_registry(name, fn ->
        :ok = LayoutRegistry.set("status", %{"type" => "paragraph", "slot" => "status", "text" => "CUSTOM"})
        assert :ok = LayoutRegistry.reset("status")

        {:ok, persisted} = Store.fetch(Memory, {:layout, name})
        refute SpellAgent.Tui.Lens.at(persisted, "status")["text"] == "CUSTOM"
      end)
    end
  end

  describe "a non-durable registry never touches the store" do
    test "set/2 on the default (non-durable) singleton writes nothing to Memory" do
      case Process.whereis(LayoutRegistry) do
        nil -> start_supervised!({LayoutRegistry, default: default_tree()})
        _ -> LayoutRegistry.seed_default(default_tree())
      end

      :ok = LayoutRegistry.set("status", %{"type" => "paragraph", "slot" => "status", "text" => "EPHEMERAL"})

      assert Store.list(Memory, :layout, nil) == []
    end
  end

  describe "replace/1 never persists (ephemeral gaze re-tags, every keystroke)" do
    test "replace/1 on a durable registry does not touch the store" do
      with_durable_registry("replace-no-persist", fn ->
        :ok = LayoutRegistry.set("status", %{"type" => "paragraph", "slot" => "status", "text" => "BASELINE"})
        {:ok, before} = Store.fetch(Memory, {:layout, "replace-no-persist"})

        # A navigation-style whole-tree replace (mirrors App.sync_layout_gaze/1).
        :ok = LayoutRegistry.replace(LayoutRegistry.tree())

        assert {:ok, ^before} = Store.fetch(Memory, {:layout, "replace-no-persist"})
      end)
    end
  end

  describe "durable?/0 introspection" do
    test "a plain (non-durable) registry reports durable?/0 == false" do
      case Process.whereis(LayoutRegistry) do
        nil -> start_supervised!({LayoutRegistry, default: default_tree()})
        _ -> LayoutRegistry.seed_default(default_tree())
      end

      refute LayoutRegistry.durable?()
    end

    test "a durable registry reports durable?/0 == true" do
      with_durable_registry("durable-flag-test", fn ->
        assert LayoutRegistry.durable?()
      end)
    end
  end

  describe "REGRESSION (review P1): seeded_durable? only fires when rehydrate ACTUALLY adopted something" do
    defp reset_registry do
      :ok = Supervisor.terminate_child(SpellAgent.Supervisor, LayoutRegistry)
      {:ok, _pid} = Supervisor.restart_child(SpellAgent.Supervisor, LayoutRegistry)
    end

    test "a FIRST --durable launch (nothing persisted yet) still gets the REAL DefaultLayout installed" do
      name = "first-durable-launch-#{System.unique_integer([:positive])}"
      reset_registry()

      LayoutRegistry.enable_durability(store: Memory, durable_name: name, rehydrate: true)

      real_default = default_tree()
      LayoutRegistry.seed_default(real_default)

      assert LayoutRegistry.tree() == real_default

      reset_registry()
      LayoutRegistry.seed_default(default_tree())
    end

    test "a --durable --fresh launch (rehydrate: false) still gets the REAL DefaultLayout installed" do
      name = "fresh-launch-#{System.unique_integer([:positive])}"
      ignored = %{"type" => "paragraph", "slot" => "status", "text" => "SHOULD BE IGNORED"}
      Store.put(Memory, {:layout, name}, ignored)

      reset_registry()
      LayoutRegistry.enable_durability(store: Memory, durable_name: name, rehydrate: false)

      real_default = default_tree()
      LayoutRegistry.seed_default(real_default)

      assert LayoutRegistry.tree() == real_default

      reset_registry()
      LayoutRegistry.seed_default(default_tree())
    end

    test "a persisted customization IS kept across seed_default/1 (the case seeded_durable? exists for)" do
      name = "real-adoption-#{System.unique_integer([:positive])}"
      custom = %{"type" => "paragraph", "slot" => "status", "text" => "REAL CUSTOMIZATION"}
      persisted_tree = SpellAgent.Tui.Lens.put_at(default_tree(), "status", custom)
      Store.put(Memory, {:layout, name}, persisted_tree)

      reset_registry()
      LayoutRegistry.enable_durability(store: Memory, durable_name: name, rehydrate: true)
      LayoutRegistry.seed_default(default_tree())

      assert SpellAgent.Tui.Lens.at(LayoutRegistry.tree(), "status")["text"] == "REAL CUSTOMIZATION"

      reset_registry()
      LayoutRegistry.seed_default(default_tree())
    end
  end
end
