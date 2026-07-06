defmodule SpellAgent.Tui.DataSourceRegistryTest do
  @moduledoc """
  PLAN-027 M0: the query-clock data-source registry — the generic seam that lets
  a `data/*` binding be produced by a registered client the render loop never
  names. Defends the registry's contract: registration/replacement, bounded
  resolve, per-producer never-brick, and the absent-registry degrade.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.DataSource.Registry

  setup do
    case Process.whereis(Registry) do
      nil -> start_supervised!({Registry, []})
      _ -> :ok
    end

    Registry.reset()
    on_exit(fn -> if Process.whereis(Registry), do: Registry.reset() end)
    :ok
  end

  describe "register/2 + resolve_all/1" do
    test "a registered producer's value appears under its name in resolve_all" do
      :ok = Registry.register("greeting", fn ctx -> "hello #{Map.get(ctx, :who)}" end)

      assert Registry.resolve_all(%{who: "world"}) == %{"greeting" => "hello world"}
    end

    test "re-registering the same name REPLACES the producer (idempotent by name)" do
      :ok = Registry.register("x", fn _ -> 1 end)
      :ok = Registry.register("x", fn _ -> 2 end)

      assert Registry.resolve_all(%{}) == %{"x" => 2}
      assert Registry.names() == ["x"]
    end

    test "multiple sources each resolve into their own key" do
      :ok = Registry.register("a", fn _ -> :a end)
      :ok = Registry.register("b", fn _ -> :b end)

      resolved = Registry.resolve_all(%{})
      assert resolved["a"] == :a
      assert resolved["b"] == :b
    end
  end

  describe "never-brick" do
    test "a producer that RAISES is omitted from resolve_all — the others survive" do
      :ok = Registry.register("ok", fn _ -> :fine end)
      :ok = Registry.register("boom", fn _ -> raise "kaboom" end)

      resolved = Registry.resolve_all(%{})
      assert resolved["ok"] == :fine
      refute Map.has_key?(resolved, "boom")
    end

    test "a producer that EXITS is omitted, never propagates" do
      :ok = Registry.register("ok", fn _ -> :fine end)
      :ok = Registry.register("dead", fn _ -> exit(:boom) end)

      resolved = Registry.resolve_all(%{})
      assert resolved["ok"] == :fine
      refute Map.has_key?(resolved, "dead")
    end
  end

  describe "bounds + validation" do
    test "an empty name is rejected" do
      assert {:error, _} = Registry.register("", fn _ -> 1 end)
    end

    test "the source cap is enforced" do
      # Fill to the cap (32) then assert the next distinct registration is rejected.
      for i <- 1..32, do: :ok = Registry.register("s#{i}", fn _ -> i end)
      assert {:error, reason} = Registry.register("overflow", fn _ -> 0 end)
      assert reason =~ "limit"
      # A replace of an EXISTING name still succeeds at the cap (no growth).
      assert :ok = Registry.register("s1", fn _ -> :replaced end)
    end

    test "unregister removes a source" do
      :ok = Registry.register("temp", fn _ -> 1 end)
      :ok = Registry.unregister("temp")
      assert Registry.resolve_all(%{}) == %{}
    end
  end

  # NB: the absent-registry degrade (register/resolve_all no-op when the process is
  # down) is guaranteed structurally by the `Process.whereis/1` guard in every
  # client fn; it is not unit-tested here because the registry is an
  # app-supervised singleton (a `stop_supervised` cannot take down the app's own
  # child), and killing the shared process races every other async-false test in
  # the suite. The guard is exercised indirectly wherever a headless caller runs
  # without the supervised registry (e.g. Cockpit.install/0 in a bare test).
end
