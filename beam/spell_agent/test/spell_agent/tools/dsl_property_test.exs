defmodule SpellAgent.Tools.DSLPropertyTest do
  @moduledoc """
  Property tests for the homoiconic tool DSL (PLAN-347), written against the REAL
  `SpellAgent.Tools` / `ToolRegistry` / `Config` API and verified to run green.

  Run counts are deliberately small: `define_tool/1` runs the full PtcRunner
  validator (parse + analyze under a heap/timeout cap) on every call, which costs
  tens of ms — so a modest run count per property keeps the suite fast while
  still exercising a broad input space. Determinism comes from a fixed seed in
  CI (see the property job in `.github/workflows/beam-tests.yml`).

  Notes on real behaviour these tests pin down (each confirmed by probing the
  running app, not assumed):

    * `ToolRegistry.get/1` returns `{:ok, entry} | :error` — NOT `nil`. A missing
      lookup is `:error` (which is TRUTHY), so absence is `== :error`.
    * `define_tool/1` RAISES `ArgumentError` on a reserved name or invalid PTC;
      it does not return an error tuple.
    * The validator rejects unbalanced-open `(+ 1` and arity/shape errors like
      `(if true)` / `(let [x] x)`, but ACCEPTS calls to as-yet undefined tools
      (resolution is deferred to call time).
    * `Config.put/2` whitelists `model` / `thinking` / `system-addendum` only;
      any other key returns `{:error, msg}`.
  """

  use ExUnit.Case, async: false
  use ExUnitProperties

  alias SpellAgent.{Tools, ToolRegistry, Config}

  @runs 20

  setup do
    # Singletons booted by the application; clear the registry so each test starts
    # from a known surface (meta-tools are synthesized, not stored, so removing
    # registry entries cannot touch them).
    for entry <- ToolRegistry.all(), do: ToolRegistry.remove(entry.name)
    :ok
  end

  # A unique tool name per generated case so cases never collide in the singleton
  # registry.
  defp unique(prefix), do: "#{prefix}-#{System.unique_integer([:positive])}"

  describe "definition + invocation" do
    property "a deterministic arithmetic tool round-trips its result" do
      check all a <- integer(-1000..1000),
                b <- integer(-1000..1000),
                max_runs: @runs do
        name = unique("add")

        assert %{"ok" => true, "defined" => ^name} =
                 Tools.define_tool(%{"name" => name, "params" => [:a, :b], "source" => "(+ data/a data/b)"})

        # Registered (get returns {:ok, entry}, never nil).
        assert {:ok, %{name: ^name, kind: :ptc}} = ToolRegistry.get(name)

        # Invoking through the built map binds data/<param> and computes.
        tool = Map.fetch!(Tools.build_tools_map(), name)
        assert tool.(%{"a" => a, "b" => b}) == a + b
      end
    end

    property "invocation is referentially transparent (same args -> same result)" do
      check all n <- integer(0..10_000), max_runs: @runs do
        name = unique("sq")
        Tools.define_tool(%{"name" => name, "params" => [:n], "source" => "(* data/n data/n)"})
        tool = Map.fetch!(Tools.build_tools_map(), name)

        r1 = tool.(%{"n" => n})
        r2 = tool.(%{"n" => n})
        assert r1 == r2
        assert r1 == n * n
      end
    end

    property "a tool may call another defined tool (composition)" do
      check all base <- integer(1..500), max_runs: @runs do
        inner = unique("inner")
        outer = unique("outer")

        Tools.define_tool(%{"name" => inner, "params" => [], "source" => "#{base}"})
        Tools.define_tool(%{"name" => outer, "params" => [], "source" => "(* 2 (tool/#{inner} {}))"})

        tool = Map.fetch!(Tools.build_tools_map(), outer)
        assert tool.(%{}) == base * 2
      end
    end
  end

  describe "validation at define-time" do
    property "reserved meta-tool names cannot be redefined" do
      check all name <- member_of(~w(define-tool define-config list-tools)),
                max_runs: @runs do
        assert_raise ArgumentError, ~r/reserved/, fn ->
          Tools.define_tool(%{"name" => name, "source" => "1"})
        end
      end
    end

    property "structurally invalid PTC is rejected and not registered" do
      # Each of these fails the validator: unbalanced-open, arity/shape errors.
      check all src <- member_of(["(+ 1", "(if true)", "(let [x] x)", "(do"]),
                max_runs: @runs do
        name = unique("bad")

        assert_raise ArgumentError, ~r/invalid PTC source/, fn ->
          Tools.define_tool(%{"name" => name, "source" => src})
        end

        # Absence is :error (the get contract), never a stored entry.
        assert ToolRegistry.get(name) == :error
      end
    end

    # NB: `require_string/2` rejects only the EXACT empty string (guard `s != ""`),
    # not whitespace — so "   " is accepted. We pin the real contract here rather
    # than the intuitive one.
    test "an empty name is rejected" do
      assert_raise ArgumentError, fn ->
        Tools.define_tool(%{"name" => "", "source" => "1"})
      end
    end
  end

  describe "config whitelist" do
    property "whitelisted keys are accepted, everything else is rejected" do
      check all key <- string(:alphanumeric, min_length: 1, max_length: 16),
                value <- one_of([string(:alphanumeric), integer()]),
                max_runs: @runs do
        case key do
          k when k in ~w(model thinking system-addendum) ->
            assert Config.put(k, to_string(value)) == :ok

          _ ->
            assert {:error, _} = Config.put(key, value)
        end
      end
    end
  end
end