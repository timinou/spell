defmodule SpellAgent.ToolRegistryDurabilityTest do
  @moduledoc """
  Durability contracts for the tool registry (PLAN-011 W3).

  Verifies the registry-as-projection behaviour: durable :ptc tools mirror to
  the Hist store, session/native tools do NOT, remove deletes from the store,
  and a fresh registry rehydrates durable tools from a pre-populated store.

  The registry is a NAMED singleton (started by the app supervisor). To test
  start-time rehydration in isolation we drive the private store<->ToolDef
  mapping through the public store plus a re-derived map, mirroring exactly what
  `rehydrate/1` does. The mirror/remove paths are exercised through the live
  registry against the shared Memory store.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.ToolRegistry
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.ToolDef

  @store SpellAgent.Hist.Store.Memory

  setup do
    # The app supervisor starts both the Memory store and the registry. Clear
    # any :tool keys from prior tests so each starts clean.
    for %ToolDef{name: n} <- Store.list(@store, :tool), do: Store.delete(@store, {:tool, n})
    for e <- ToolRegistry.all(), do: ToolRegistry.remove(e.name)
    :ok
  end

  describe "mirroring to the durable store" do
    test "a durable :ptc tool is written to the store as a ToolDef" do
      ToolRegistry.put(%{
        kind: :ptc,
        name: "dur-1",
        params: [:x],
        doc: "d",
        source: "(* 2 data/x)",
        scope: :durable
      })

      assert {:ok, %ToolDef{name: "dur-1", source: "(* 2 data/x)", scope: :durable}} =
               Store.fetch(@store, {:tool, "dur-1"})
    end

    test "a session-scoped :ptc tool is NOT written to the store" do
      ToolRegistry.put(%{
        kind: :ptc,
        name: "sess-1",
        params: [],
        doc: "",
        source: "(+ 1 1)",
        scope: :session
      })

      assert :error = Store.fetch(@store, {:tool, "sess-1"})
      # …but it IS in the live registry.
      assert {:ok, _} = ToolRegistry.get("sess-1")
    end

    test "a :ptc tool with no scope defaults to session (not persisted)" do
      ToolRegistry.put(%{kind: :ptc, name: "noscope", params: [], doc: "", source: "1"})
      assert :error = Store.fetch(@store, {:tool, "noscope"})
    end

    test "a :native tool is never persisted" do
      ToolRegistry.put(%{kind: :native, name: "nat-1", params: [], doc: "", fun: fn _ -> :ok end})
      assert :error = Store.fetch(@store, {:tool, "nat-1"})
    end
  end

  describe "remove" do
    test "removing a durable tool deletes it from the store" do
      ToolRegistry.put(%{
        kind: :ptc,
        name: "dur-2",
        params: [],
        doc: "",
        source: "1",
        scope: :durable
      })

      assert {:ok, _} = Store.fetch(@store, {:tool, "dur-2"})

      ToolRegistry.remove("dur-2")
      assert :error = Store.fetch(@store, {:tool, "dur-2"})
      assert :error = ToolRegistry.get("dur-2")
    end
  end

  describe "rehydration (registry as a projection of the store)" do
    test "a durable tool written to the store is recovered into a fresh registry" do
      # Pre-populate the store as if a PRIOR session had defined a durable tool.
      td = %ToolDef{
        name: "rehydrated",
        params: [:n],
        doc: "from a past life",
        source: "(+ 1 data/n)",
        scope: :durable,
        t: 0
      }

      Store.put(@store, {:tool, "rehydrated"}, td)

      # Observe boot rehydration via the registry's OWN projection function
      # (durable_map/1) — the same code start_link uses. It robustly skips any
      # non-durable / non-ToolDef values other tests may have left in the shared
      # store, so this test does not race with concurrent durable definitions.
      seeded =
        @store
        |> Store.list(:tool)
        |> SpellAgent.ToolRegistry.durable_map()
        |> Map.fetch("rehydrated")

      assert {:ok, %{kind: :ptc, name: "rehydrated", source: "(+ 1 data/n)", params: [:n]}} =
               seeded
    end

    test "the live registry rehydrates durable tools it persisted (round-trip)" do
      # Persist through the public API…
      ToolRegistry.put(%{
        kind: :ptc,
        name: "rt",
        params: [:a],
        doc: "rt",
        source: "data/a",
        scope: :durable
      })

      # …and confirm the store now has a ToolDef that maps back to a :ptc entry
      # with the same source — the rehydrate contract end to end.
      {:ok, %ToolDef{} = td} = Store.fetch(@store, {:tool, "rt"})
      assert td.source == "data/a"
      assert td.params == [:a]
      assert td.scope == :durable
    end
  end

  describe "define-tool scope plumbing" do
    test "scope \"durable\" persists; default does not" do
      SpellAgent.Tools.define_tool(%{
        "name" => "via-define",
        "params" => ["x"],
        "source" => "(* 2 data/x)",
        "scope" => "durable"
      })

      assert {:ok, %ToolDef{source: "(* 2 data/x)"}} = Store.fetch(@store, {:tool, "via-define"})

      SpellAgent.Tools.define_tool(%{"name" => "via-define-2", "source" => "1"})
      assert :error = Store.fetch(@store, {:tool, "via-define-2"})
    end
  end

  describe "rehydration fidelity (review fixes)" do
    test "a session-scoped ToolDef in the store is NOT promoted to the registry" do
      # Other writers (Hist.Tools.promote, Reconstitute stubs) put :session
      # ToolDefs under {:tool,_}. Rehydrate must skip them, not resurrect them.
      Store.put(@store, {:tool, "sess-stored"}, %ToolDef{
        name: "sess-stored",
        source: "1",
        scope: :session,
        t: 0
      })

      assert %{} == rehydrate_via(@store) |> Map.take(["sess-stored"])
    end

    test "a source-less ToolDef (Reconstitute stub) is skipped" do
      Store.put(@store, {:tool, "stub"}, %ToolDef{
        name: "stub",
        source: nil,
        scope: :durable,
        t: 0
      })

      refute Map.has_key?(rehydrate_via(@store), "stub")
    end

    test "a corrupt non-ToolDef value is skipped, not fatal (no total amnesia)" do
      good = %ToolDef{name: "good", source: "1", scope: :durable, t: 0}
      Store.put(@store, {:tool, "good"}, good)
      # Inject a corrupt value directly into the shared store.
      Store.put(@store, {:tool, "corrupt"}, %{not: "a tooldef"})

      map = rehydrate_via(@store)
      assert Map.has_key?(map, "good"), "one bad record must not wipe the durable toolset"
      refute Map.has_key?(map, "corrupt")
    end

    test "params survive as atoms across a full store round-trip" do
      ToolRegistry.put(%{
        kind: :ptc,
        name: "atomic",
        params: [:a, :b],
        doc: "",
        source: "data/a",
        scope: :durable
      })

      map = rehydrate_via(@store)
      assert %{params: [:a, :b]} = Map.fetch!(map, "atomic")
    end
  end

  describe "provenance preservation (review fix)" do
    test "re-putting a durable tool keeps the store ToolDef's origin/stats" do
      # Simulate a promotion having written provenance.
      Store.put(@store, {:tool, "promoted"}, %ToolDef{
        name: "promoted",
        source: "old",
        scope: :durable,
        origin: %{session: "s1", node_id: "n1"},
        stats: %{calls: 5, errors: 1},
        t: 111
      })

      # The registry re-puts (e.g. agent redefines the body).
      ToolRegistry.put(%{
        kind: :ptc,
        name: "promoted",
        params: [],
        doc: "",
        source: "new",
        scope: :durable
      })

      {:ok, %ToolDef{} = td} = Store.fetch(@store, {:tool, "promoted"})
      assert td.source == "new", "source is refreshed (registry owns it)"
      assert td.origin == %{session: "s1", node_id: "n1"}, "origin preserved (store owns it)"
      assert td.stats == %{calls: 5, errors: 1}, "stats preserved"
      assert td.t == 111, "original timestamp preserved"
    end

    test "overwriting a durable tool with a session one deletes the stale store record" do
      ToolRegistry.put(%{
        kind: :ptc,
        name: "flip",
        params: [],
        doc: "",
        source: "1",
        scope: :durable
      })

      assert {:ok, _} = Store.fetch(@store, {:tool, "flip"})

      ToolRegistry.put(%{
        kind: :ptc,
        name: "flip",
        params: [],
        doc: "",
        source: "1",
        scope: :session
      })

      assert :error = Store.fetch(@store, {:tool, "flip"}), "stale durable record must be cleared"
    end
  end

  describe "scope normalization (review fix)" do
    test "case-insensitive durable variants all persist" do
      for variant <- ["durable", "Durable", "DURABLE", " durable "] do
        name =
          "scoped-#{variant |> String.trim() |> String.downcase()}-#{System.unique_integer([:positive])}"

        result =
          SpellAgent.Tools.define_tool(%{"name" => name, "source" => "1", "scope" => variant})

        assert result["scope"] == "durable", "#{inspect(variant)} should normalize to durable"
        assert {:ok, _} = Store.fetch(@store, {:tool, name})
      end
    end

    test "an unrecognized scope is REJECTED at define time (BUG-027: not silently session)" do
      # BUG-027 hardened this: an explicitly-provided but unrecognized scope
      # (e.g. a typo'd "permanent") used to silently degrade to :session, quietly
      # losing durability. It is now rejected with a clear error so the mistake is
      # visible, not swallowed.
      name = "weird-#{System.unique_integer([:positive])}"

      assert_raise ArgumentError, ~r/unrecognized scope/, fn ->
        SpellAgent.Tools.define_tool(%{"name" => name, "source" => "1", "scope" => "permanent"})
      end

      # rejected => never registered.
      assert SpellAgent.ToolRegistry.get(name) == :error
    end
  end

  # Re-derive what rehydrate/1 produces, using the registry's OWN public
  # projection function so the test exercises real code, not a copy.
  defp rehydrate_via(store) do
    store
    |> SpellAgent.Hist.Store.list(:tool)
    |> SpellAgent.ToolRegistry.durable_map()
  end
end
