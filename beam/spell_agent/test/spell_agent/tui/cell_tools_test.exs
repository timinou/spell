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
  alias SpellAgent.Tui.Store.Span
  alias SpellAgent.Tui.Ui

  defp frozen(src) do
    {:ok, step} = Lisp.run("(quote #{src})")
    step.return
  end

  # A minimal live span forest + a tree gaze whose cursor sits on "root", so a
  # cell can resolve a REAL forest read (cursor-id -> descendants) end to end
  # (mirrors the harness_test fixture).
  defp forest do
    %{
      "root" => %Span{
        id: "root",
        parent_id: nil,
        kind: :run,
        status: :ok,
        label: "r",
        children: ["c"]
      },
      "c" => %Span{
        id: "c",
        parent_id: "root",
        kind: :tool,
        status: :ok,
        label: "t",
        children: ["g"]
      },
      "g" => %Span{id: "g", parent_id: "c", kind: :llm, status: :ok, label: "llm"}
    }
  end

  defp tree_ui, do: Ui.new(focus: :tree, auto_depth: 10) |> Map.put(:cursors, %{tree: 0})

  # ============================================================
  # allowlist / denylist shape
  # ============================================================

  describe "the capability tier is a fail-closed allowlist" do
    test "admits the harness read verbs the live-callers demo needs" do
      assert Tools.allowed?("harness/cursor-id")
      assert Tools.allowed?("harness/descendants")
      assert Tools.allowed?("harness/ancestors")
    end

    test "excludes named mutators (pinned literally, not derived from the set)" do
      # Pin the mutator names HERE so deleting a verb from the production
      # @forbidden set cannot silently delete its assertion (the reviewer's
      # tautology concern). Every namespace a cell must never reach is represented.
      for verb <- ~w(
            keymap/bind keymap/unbind keymap/define-reaction
            hist/promote hist/crystallize
            define-tool define-config
            sh sh-pipe layout/set theme/set
          ) do
        refute Tools.allowed?(verb), "mutator #{verb} must not be cell-callable"
      end
    end

    test "every forbidden-set member is also denied (set-level guard)" do
      for verb <- Tools.forbidden_verbs() do
        refute Tools.allowed?(verb), "forbidden #{verb} must not be cell-callable"
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

    test "no keymap mutator survives the filter (every keymap/* key absent)" do
      # Assert the built tier contains NO key under the mutating keymap/* namespace
      # — stronger than naming two verbs, catches a future allowlisted keymap verb.
      tier = Tools.read_only(forest(), tree_ui())

      keymap_keys = for {name, _} <- tier, String.starts_with?(name, "keymap/"), do: name
      assert keymap_keys == [], "keymap mutators leaked into the tier: #{inspect(keymap_keys)}"
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
    test "a forest read resolves to LIVE forest data through the tier" do
      # The acceptance mechanic in miniature: a cell reads the cursor span and
      # walks its descendants — a REAL forest query, not the forest-ignoring
      # harness/state. Proves the tier is wired to live data, not just callable.
      tier = Tools.read_only(forest(), tree_ui())

      assert {:ok, [_ | _] = descendants} =
               Cell.resolve(
                 frozen(~S|(harness/descendants {:id (harness/cursor-id)})|),
                 %{},
                 tier
               )

      # cursor sits on "root"; its descendants are c + g.
      assert Enum.sort(descendants) == ["c", "g"]
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
