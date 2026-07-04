defmodule SpellAgent.Tui.PaneRegistryTest do
  @moduledoc """
  Tests for `SpellAgent.Tui.PaneRegistry` (PLAN-024 Wave 1 / FUP-005) — the
  bounded runtime pane-name registry. Proves the contract mirrors
  `KeymapRegistry.define_intent/1`: bounded, capped, shape-gated, never a
  double-intern for the same name.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.PaneRegistry

  setup do
    case Process.whereis(PaneRegistry) do
      nil -> start_supervised!(PaneRegistry)
      _pid -> :ok
    end

    PaneRegistry.reset()
    :ok
  end

  describe "define_pane/1" do
    test "a well-shaped name interns once and is reused on repeat calls" do
      assert {:ok, atom1} = PaneRegistry.define_pane("cost-histo")
      assert {:ok, atom2} = PaneRegistry.define_pane("cost-histo")
      assert atom1 == atom2
      assert atom1 == :"cost-histo"
    end

    test "known?/1 recognizes a declared pane" do
      {:ok, atom} = PaneRegistry.define_pane("mypane")
      assert PaneRegistry.known?(atom)
      refute PaneRegistry.known?(:some_never_declared_atom)
    end

    test "an uppercase or slash-shaped name is rejected" do
      assert {:error, _} = PaneRegistry.define_pane("CostHisto")
      assert {:error, _} = PaneRegistry.define_pane("cost/histo")
      assert {:error, _} = PaneRegistry.define_pane("1leading-digit")
      assert {:error, _} = PaneRegistry.define_pane("")
    end

    test "an overlong name is rejected before interning" do
      long = String.duplicate("a", 200)
      assert {:error, msg} = PaneRegistry.define_pane(long)
      assert msg =~ "too long"
      assert_raise ArgumentError, fn -> String.to_existing_atom(long) end
    end

    test "the runtime-pane cap is enforced" do
      results = for i <- 1..100, do: PaneRegistry.define_pane("cap#{i}")
      ok_count = Enum.count(results, &match?({:ok, _}, &1))
      err_count = Enum.count(results, &match?({:error, _}, &1))

      assert ok_count <= 64
      assert err_count > 0
    end

    test "reuse of an already-declared name never counts against the cap again" do
      {:ok, _} = PaneRegistry.define_pane("reuseme")
      before = length(PaneRegistry.all())

      for _ <- 1..10, do: PaneRegistry.define_pane("reuseme")

      assert length(PaneRegistry.all()) == before
    end
  end

  describe "lookup/1 — never interns" do
    test "an undeclared name resolves to nil, no new atom" do
      uniq = "neverdeclared#{System.unique_integer([:positive])}"
      assert PaneRegistry.lookup(uniq) == nil
      assert_raise ArgumentError, fn -> String.to_existing_atom(uniq) end
    end

    test "a declared name resolves to its atom" do
      {:ok, atom} = PaneRegistry.define_pane("lookupme")
      assert PaneRegistry.lookup("lookupme") == atom
    end
  end
end
