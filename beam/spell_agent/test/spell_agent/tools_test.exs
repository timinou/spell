defmodule SpellAgent.ToolsTest do
  use ExUnit.Case, async: false

  alias SpellAgent.{Config, Tools, ToolRegistry}

  setup do
    # The registry + config are session-global GenServers (started by the app).
    # Reset them between tests so cases don't leak defined tools into each other.
    for e <- ToolRegistry.all(), do: ToolRegistry.remove(e.name)
    Config.put("model", "claude-sonnet-4-5-20250929")
    :ok
  end

  defp call(name, args) do
    Tools.build_tools_map() |> Map.fetch!(name) |> then(& &1.(args))
  end

  describe "define-tool → stored PTC program is callable" do
    test "a defined arithmetic tool runs with args bound as data/<param>" do
      assert %{"ok" => true, "defined" => "double"} =
               Tools.define_tool(%{"name" => "double", "params" => ["n"], "source" => "(* 2 data/n)"})

      assert call("double", %{"n" => 21}) == 42
    end

    test "a defined tool can call a NATIVE tool (list-tools) — composition" do
      # The exact native-tool count grows as the surface does (spawn-session +
      # await-session in FEAT-011, the mesh/* combinators in FEAT-018, …), so the
      # contract here is COMPOSITION: a defined tool can call list-tools and see
      # itself plus the always-present meta + sh tools — NOT a brittle magic total.
      Tools.define_tool(%{"name" => "count-tools", "params" => [], "source" => "(count (tool/list-tools {}))"})
      count = call("count-tools", %{})

      # Always-present native tools: 3 meta (define-tool, define-config,
      # list-tools) + 4 sh (sh, sh-pipe, sh-parse, sh-unparse; PLAN-011) + 3 code
      # (code-parse, code-unparse, code-edit; PLAN-020) + code-apply (FEAT-025),
      # plus count-tools itself.
      # Asserted as a floor so inventory growth never breaks this test.
      assert is_integer(count)
      assert count >= 11
      # list-tools includes the just-defined tool (composition + self-visibility).
      # FEAT-035: the inventory now displays each callable in the form the agent
      # types it — `tool/`-routed tools (native, meta, and runtime-defined) show
      # `tool/<name>`; bare-routed surfaces (harness/black/view) show bare.
      names = Enum.map(Tools.inventory(), & &1["name"])
      assert "tool/count-tools" in names
      assert "tool/list-tools" in names
      assert "tool/code-edit" in names
    end

    test "a defined tool can call ANOTHER defined tool" do
      Tools.define_tool(%{"name" => "inc", "params" => ["n"], "source" => "(+ 1 data/n)"})
      Tools.define_tool(%{"name" => "inc2", "params" => ["n"], "source" => "(tool/inc {:n (tool/inc {:n data/n})})"})
      assert call("inc2", %{"n" => 40}) == 42
    end
  end

  describe "validation + guards" do
    test "malformed PTC source is rejected at define time with a clear error" do
      assert_raise ArgumentError, ~r/invalid PTC source/, fn ->
        Tools.define_tool(%{"name" => "bad", "params" => [], "source" => "(+ 1 "})
      end

      assert ToolRegistry.get("bad") == :error
    end

    test "cannot redefine a reserved meta-tool" do
      assert_raise ArgumentError, ~r/reserved tool/, fn ->
        Tools.define_tool(%{"name" => "list-tools", "params" => [], "source" => "42"})
      end
    end

    test "missing name/source raises" do
      assert_raise ArgumentError, fn -> Tools.define_tool(%{"params" => [], "source" => "1"}) end
      assert_raise ArgumentError, fn -> Tools.define_tool(%{"name" => "x", "params" => []}) end
    end
  end

  describe "define-time integrity (BUG-027)" do
    test "(1) a body calling an UNKNOWN bare tool is rejected at define time" do
      assert_raise ArgumentError, ~r/unknown tool/, fn ->
        Tools.define_tool(%{
          "name" => "typo-caller",
          "params" => [],
          "source" => "(tool/definitely-not-a-tool {:a 1})"
        })
      end

      # rejected => never registered.
      assert ToolRegistry.get("typo-caller") == :error
    end

    test "(1) a body calling an UNKNOWN namespace prefix is rejected" do
      # An unknown NAMESPACE is caught even earlier — by the analyzer's bounded-
      # namespace check in validate_source (defense in depth) — with a clear
      # "unknown namespace" message listing the legal ones. Either way it is
      # rejected at define time and never registered.
      assert_raise ArgumentError, ~r/invalid PTC source|unknown namespace|unknown tool/, fn ->
        Tools.define_tool(%{
          "name" => "bad-ns",
          "params" => [],
          "source" => "(bogusns/whatever {:a 1})"
        })
      end

      assert ToolRegistry.get("bad-ns") == :error
    end

    test "(1) a body calling a VALID native + a KNOWN namespace verb is accepted" do
      # sh (native), hist/reduce (session verb, not in base map but catalog-known),
      # and q/update (prelude) must all pass the closed-world check.
      assert %{"ok" => true} =
               Tools.define_tool(%{
                 "name" => "valid-callees",
                 "params" => ["p"],
                 "source" =>
                   "(do (tool/sh {:argv [\"echo\" data/p]}) (tool/hist/reduce {:tier \"lossy\"}))"
               })
    end

    test "(1) self-recursion is allowed (the tool may call itself)" do
      assert %{"ok" => true} =
               Tools.define_tool(%{
                 "name" => "recur-tool",
                 "params" => ["n"],
                 "source" => "(if (< data/n 1) 0 (tool/recur-tool {:n (- data/n 1)}))"
               })
    end

    test "(2) an UNRECOGNIZED scope is rejected, not silently degraded to session" do
      assert_raise ArgumentError, ~r/unrecognized scope/, fn ->
        Tools.define_tool(%{
          "name" => "typo-scope",
          "params" => [],
          "source" => "1",
          "scope" => "permannet"
        })
      end

      assert ToolRegistry.get("typo-scope") == :error
    end

    test "(2) a recognized scope still resolves (durable/session/absent)" do
      assert %{"scope" => "durable"} =
               Tools.define_tool(%{"name" => "d1", "params" => [], "source" => "1", "scope" => "durable"})

      assert %{"scope" => "session"} =
               Tools.define_tool(%{"name" => "s1", "params" => [], "source" => "1", "scope" => "session"})

      # absent scope defaults to session (no rejection).
      assert %{"scope" => "session"} =
               Tools.define_tool(%{"name" => "s2", "params" => [], "source" => "1"})
    end

    test "(3) a RESERVED param name is rejected at define time" do
      assert_raise ArgumentError, ~r/reserved/, fn ->
        Tools.define_tool(%{"name" => "bad-param", "params" => ["return"], "source" => "1"})
      end
    end

    test "(3) an ILL-FORMED param name is rejected" do
      assert_raise ArgumentError, ~r/valid identifier/, fn ->
        Tools.define_tool(%{"name" => "bad-param2", "params" => ["has space"], "source" => "1"})
      end
    end

    test "(4) a `proxy_`-prefixed tool name is rejected (wire-prefix collision)" do
      assert_raise ArgumentError, ~r/proxy_/, fn ->
        Tools.define_tool(%{"name" => "proxy_find", "params" => [], "source" => "1"})
      end
    end

    # --- S1 review regressions (PLAN-025 W1 reviewer swarm) --------------------

    test "(S1-3) an unknown MEMBER of a fixed namespace is rejected, not just unknown prefixes" do
      # harness/ is a FIXED (fully-enumerated) namespace. A typo'd member
      # (harness/misspelled) must be rejected — the prefix being known is NOT
      # enough. (Regression for the too-loose prefix-only check.)
      assert_raise ArgumentError, ~r/unknown tool/, fn ->
        Tools.define_tool(%{"name" => "s1-3", "params" => [], "source" => "(harness/no-such-verb {})"})
      end
    end

    test "(S1-3) a valid member of an OPEN namespace (view/*) is accepted" do
      # view/ is reflected/open (one verb per ex_ratatui widget), so it is
      # admitted on the prefix — an open namespace cannot be enumerated.
      assert %{"ok" => true} =
               Tools.define_tool(%{"name" => "s1-3b", "params" => [], "source" => "(view/paragraph {})"})
    end

    test "(S1-4) an unknown callee HIDDEN inside defonce/try/probe is still caught" do
      # referenced_tools must walk container forms, else a typo'd callee slips the
      # gate and only fails at runtime.
      for src <- [
            "(defonce x (tool/unregistered-a {}))",
            "(try (tool/unregistered-b {}) (catch e 1))",
            "(probe \"p\" (tool/unregistered-c {}))"
          ] do
        assert_raise ArgumentError, ~r/unknown tool/, fn ->
          Tools.define_tool(%{"name" => "s1-4-#{:erlang.phash2(src)}", "params" => [], "source" => src})
        end
      end
    end

    test "(S1-2) a REGISTERED slash-named tool is a valid callee" do
      # A runtime tool name may contain `/` (e.g. "pkg/foo"). Once registered it is
      # in the known callable set and must be accepted as a callee by exact name.
      Tools.define_tool(%{"name" => "pkg/foo", "params" => [], "source" => "1"})

      assert %{"ok" => true} =
               Tools.define_tool(%{"name" => "s1-2", "params" => [], "source" => "(tool/pkg/foo {})"})
    end

    test "(S1-1) params are kept as STRINGS (no atom-table growth from user names)" do
      # A user-controlled param name must not be `String.to_atom`'d (atom-table
      # DoS). Params are metadata-only strings.
      unique = "p_#{System.unique_integer([:positive])}"
      %{"params" => ps} =
        Tools.define_tool(%{"name" => "s1-1", "params" => [unique], "source" => "1"})

      assert ps == [unique]
      # the name must NOT have become an atom.
      assert_raise ArgumentError, fn -> String.to_existing_atom(unique) end
    end
  end

  describe "inventory + introspection" do
    test "list-tools surfaces meta-tools and runtime-defined tools as data" do
      Tools.define_tool(%{"name" => "blast", "params" => ["sym"], "doc" => "impact", "source" => "data/sym"})

      inv = call("list-tools", %{})
      names = Enum.map(inv, & &1["name"])

      # FEAT-035: names are displayed in agent-call form (`tool/<name>` for the
      # tool-routed surface, including runtime-defined tools).
      assert "tool/define-tool" in names
      assert "tool/define-config" in names
      assert "tool/list-tools" in names
      assert "tool/blast" in names

      blast = Enum.find(inv, &(&1["name"] == "tool/blast"))
      assert blast["params"] == ["sym"]
      assert blast["doc"] == "impact"
      assert blast["kind"] == "ptc"
    end

    test "a tool defined now appears in the inventory immediately (next-turn visibility)" do
      refute Enum.any?(Tools.inventory(), &(&1["name"] == "tool/fresh"))
      Tools.define_tool(%{"name" => "fresh", "params" => [], "source" => "1"})
      assert Enum.any?(Tools.inventory(), &(&1["name"] == "tool/fresh"))
    end
  end

  describe "define-config" do
    test "sets a whitelisted key" do
      assert %{"ok" => true, "set" => "model"} = Tools.define_config(%{"key" => "model", "value" => "claude-x"})
      assert Config.get("model") == "claude-x"
    end

    test "rejects an unknown key" do
      assert_raise ArgumentError, ~r/unknown config key/, fn ->
        Tools.define_config(%{"key" => "bogus", "value" => 1})
      end
    end
  end
end
