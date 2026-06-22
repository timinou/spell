defmodule SpellAgent.Tui.Cell.ToolsTest do
  @moduledoc """
  W1 contract (PROJ-004): the read-only capability tier for reactive cells.

  The security invariant: a cell may call READ-ONLY query verbs and NOTHING that
  mutates. Pins: the allowlist admits the harness forest-reads, every known
  mutator is excluded, the two sets are provably disjoint, the filtered map
  actually drives a `Cell.resolve` to read the live forest, and a mutating verb is
  unreachable through the tier (degrades to :error, never acts).
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp
  alias SpellAgent.Tui.Cell
  alias SpellAgent.Tui.Cell.Tools

  defp frozen(src) do
    {:ok, step} = Lisp.run("(quote #{src})")
    step.return
  end

  # ============================================================
  # allowlist / denylist shape
  # ============================================================

  describe "the capability tier is a fail-closed allowlist" do
    test "admits the harness read verbs the live-callers demo needs" do
      assert Tools.allowed?("harness/cursor-id")
      assert Tools.allowed?("harness/descendants")
      assert Tools.allowed?("harness/ancestors")
    end

    test "excludes every known mutator" do
      for verb <- Tools.forbidden_verbs() do
        refute Tools.allowed?(verb), "mutator #{verb} must not be cell-callable"
      end
    end

    test "an unknown/unlisted verb is denied (fail-closed default)" do
      refute Tools.allowed?("some/brand-new-verb")
      refute Tools.allowed?("tool/edit")
      refute Tools.allowed?(nil)
    end

    test "the allowlist and the known-mutator set are disjoint" do
      assert MapSet.disjoint?(Tools.read_only_verbs(), Tools.forbidden_verbs())
    end
  end

  # ============================================================
  # the built tier filters Harness.tools correctly
  # ============================================================

  describe "read_only/2 filters the live tool surface" do
    test "every verb in the built tier is on the allowlist" do
      tier = Tools.read_only(%{})

      for {name, _fun} <- tier do
        assert Tools.allowed?(name), "built tier leaked non-allowed verb #{name}"
      end
    end

    test "no keymap mutator survives the filter" do
      tier = Tools.read_only(%{})
      refute Map.has_key?(tier, "keymap/bind")
      refute Map.has_key?(tier, "keymap/define-reaction")
    end

    test "the harness reads survive the filter" do
      tier = Tools.read_only(%{})
      assert Map.has_key?(tier, "harness/cursor-id")
      assert Map.has_key?(tier, "harness/descendants")
    end
  end

  # ============================================================
  # end-to-end: the tier drives a cell to read, never to act
  # ============================================================

  describe "a cell resolves through the read-only tier" do
    test "a read verb in the tier resolves to live forest data" do
      # harness/state returns the gaze as a map; a cell can read it. This proves
      # the tier is not just shape-correct but actually CALLABLE from a cell.
      tier = Tools.read_only(%{})
      assert {:ok, value} = Cell.resolve(frozen(~S|(harness/state {})|), %{}, tier)
      assert is_map(value)
    end

    test "a mutating verb is unreachable through the tier (degrades to :error)" do
      # keymap/bind is a registry mutator; even though Harness.tools defines it,
      # the tier filters it out, so a cell calling it hits 'unknown tool' -> :error.
      # The UI is NOT mutated by the cell being resolved.
      tier = Tools.read_only(%{})

      assert :error =
               Cell.resolve(
                 frozen(~S|(keymap/bind {:chord "C-x" :intent "app/quit" :context "tree"})|),
                 %{},
                 tier
               )
    end
  end
end
