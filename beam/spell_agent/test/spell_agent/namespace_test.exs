defmodule SpellAgent.NamespaceTest do
  use ExUnit.Case, async: true

  alias SpellAgent.{Namespace, Tools}
  alias SpellAgent.Namespace.{Catalog, Context}

  describe "atom-safety drift guard (PLAN-025 W1 / FEAT-035)" do
    test "every bare-routed namespace prefix is bounded in ptc_runner SourceAtoms" do
      # A bare-routed `(prefix/verb …)` only parses if `prefix` is a bounded
      # namespace atom. If someone adds a bare namespace to the catalog without
      # bounding its prefix in ptc_runner, this fails loudly instead of the agent
      # silently getting an undefined-var at call time.
      assert Namespace.verify_atom_safety(Catalog.specs()) == :ok
    end
  end

  describe "single source of truth: tools map ↔ inventory (FEAT-035)" do
    test "every STATIC declared verb resolves to a callable in the tools map" do
      # The base tools map (meta + native + freeform) must contain a callable for
      # every static verb the catalog declares (harness is built per-render, so it
      # is excluded from the base map by design and checked separately).
      base = Tools.build_tools_map()

      static_verbs =
        Catalog.specs()
        |> Enum.filter(&(&1.scope == :static and &1.prefix not in ["harness", "view"]))
        |> Enum.flat_map(& &1.verbs)
        |> Enum.map(& &1.name)

      for name <- static_verbs do
        assert Map.has_key?(base, name), "static verb #{inspect(name)} missing from tools map"
      end
    end

    test "every SESSION declared verb resolves to a callable when folded with a context" do
      ctx = %Context{
        session_id: "test-session",
        hist_store: SpellAgent.Hist.default_store(),
        llm: nil,
        max_turns: 12,
        region: "test-region",
        allowed: :all
      }

      folded = Namespace.session_tools_map(Catalog.specs(), ctx)

      session_verbs =
        Catalog.specs()
        |> Enum.filter(&(&1.scope == :session and &1.prefix != "mesh"))
        |> Enum.flat_map(& &1.verbs)
        |> Enum.map(& &1.name)

      for name <- session_verbs do
        assert Map.has_key?(folded, name),
               "session verb #{inspect(name)} missing from folded tools map"
      end
    end

    test "inventory covers the session surface the old mirror omitted" do
      # The pre-FEAT-035 inventory omitted hist/*, black/*, clock/*, and the
      # freeform surface entirely. The derived inventory must include them.
      names = MapSet.new(Tools.inventory(), & &1["name"])

      for expected <- [
            "tool/hist/reduce",
            "tool/clock/at",
            "black/post",
            "harness/expand",
            "tool/spawn-session",
            "tool/mesh/scatter"
          ] do
        assert MapSet.member?(names, expected),
               "inventory missing #{inspect(expected)} (drift the registry was meant to kill)"
      end
    end

    test "every inventory entry carries a non-empty doc" do
      # A capability with no doc is invisible guidance to the LLM. `view/*` is the
      # one reflected placeholder; everything else must be documented.
      undocumented =
        Tools.inventory()
        |> Enum.filter(&(&1["doc"] == ""))
        |> Enum.map(& &1["name"])

      assert undocumented == [], "undocumented capabilities: #{inspect(undocumented)}"
    end
  end

  describe "capability prompt (FEAT-034)" do
    test "the rendered capability text covers the whole session + freeform surface" do
      # The prompt's capability description is DERIVED from the registry, so every
      # namespace the old hand-maintained prose omitted must now appear. This is
      # the anti-drift guarantee: what the agent is told it can call == what it
      # can actually call.
      text = SpellAgent.Namespace.Prompt.capability_text()

      for expected <- [
            "tool/define-tool",
            "tool/sh",
            "tool/code-edit",
            "tool/hist/reduce",
            "tool/clock/at",
            "black/post",
            "tool/spawn-session",
            "tool/mesh/scatter",
            "harness/expand",
            "theme/set"
          ] do
        assert String.contains?(text, expected),
               "capability prompt missing #{inspect(expected)}"
      end
    end

    test "a runtime-defined tool appears in the capability text" do
      SpellAgent.Tools.define_tool(%{
        "name" => "cap-probe",
        "params" => ["x"],
        "doc" => "a probe tool",
        "source" => "data/x"
      })

      text = SpellAgent.Namespace.Prompt.capability_text()
      assert String.contains?(text, "tool/cap-probe")
      assert String.contains?(text, "your tools")
    end
  end

  describe "routing display form" do
    test "tool-routed verbs display as tool/<name>, bare-routed display bare" do
      assert Namespace.display_name(:tool, "sh") == "tool/sh"
      assert Namespace.display_name(:tool, "hist/reduce") == "tool/hist/reduce"
      assert Namespace.display_name(:bare, "harness/expand") == "harness/expand"
      assert Namespace.display_name(:bare, "black/post") == "black/post"
    end
  end

  describe "harness/keymap metadata ↔ live builder (no drift)" do
    test "the catalog's harness verbs exactly match Harness.tools/2 live keys" do
      # harness/keymap verbs are built per-render by Harness.tools/2 (they close
      # over the live forest + gaze), so the catalog carries only their inventory
      # metadata. This test is the drift guard: the declared set must equal the
      # live callable set, so the capability prompt never lies about the surface.
      declared =
        Catalog.specs()
        |> Enum.filter(&(&1.prefix == "harness"))
        |> Enum.flat_map(& &1.verbs)
        |> Enum.map(& &1.name)
        |> MapSet.new()

      live =
        SpellAgent.Harness.tools(%{}, SpellAgent.Tui.Ui.new())
        |> Map.keys()
        |> MapSet.new()

      assert MapSet.difference(declared, live) |> MapSet.to_list() == [],
             "catalog declares harness verbs that are not live"

      assert MapSet.difference(live, declared) |> MapSet.to_list() == [],
             "live harness verbs missing from the catalog inventory"
    end
  end

  describe "attenuation preserved through the catalog fold" do
    test "black/* verbs only appear when a region is present" do
      base_ctx = %Context{
        session_id: "s",
        hist_store: SpellAgent.Hist.default_store(),
        llm: nil,
        max_turns: 12,
        allowed: :all
      }

      without_region = Namespace.session_tools_map(Catalog.specs(), %{base_ctx | region: nil})
      with_region = Namespace.session_tools_map(Catalog.specs(), %{base_ctx | region: "r1"})

      refute Map.has_key?(without_region, "black/post")
      assert Map.has_key?(with_region, "black/post")
    end
  end
end
