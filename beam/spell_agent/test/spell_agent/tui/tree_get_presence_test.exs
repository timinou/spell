defmodule SpellAgent.Tui.TreeGetPresenceTest do
  @moduledoc """
  Regression test for a bug found while building PLAN-024 Wave 1: `Tree.get/2`
  used `Map.get(m, key) || Map.get(m, safe_atom(key))`, which cannot distinguish
  a key PRESENT with a falsy value (`false`/`nil`) from a key ABSENT — `false ||
  x` always evaluates `x`. This masked a stored `"focusable" => false` tag
  (falling through to a nonexistent atom key, returning `nil`, read as "tag not
  set" instead of "explicitly false"), breaking `Lens.focusables/1`'s opt-out
  path (PLAN-024 Wave 1: FUP-005 pane registry / the dead `focusable` tag now
  wired as a real predicate).

  Fixed to be presence-aware: check `Map.has_key?/2` FIRST, return the stored
  value (even if falsy) as soon as the key is present under either spelling.
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.Tree

  describe "get/2 — presence over truthiness" do
    test "a stored `false` value is returned, not masked by the atom-key fallback" do
      assert Tree.get(%{"flag" => false}, "flag") == false
    end

    test "a stored `nil` value is returned (key present), not confused with absence" do
      assert Tree.get(%{"flag" => nil}, "flag") == nil
      # Still distinguishable from a truly-absent key via presence, if a caller
      # needs that distinction elsewhere (Tree.path?/has_key?).
    end

    test "an absent key still yields nil (unchanged contract)" do
      assert Tree.get(%{}, "flag") == nil
    end

    test "the atom-key fallback still works for a genuinely absent string key" do
      m = %{flag: true}
      assert Tree.get(m, "flag") == true
    end

    test "a false STRING-key value is not masked by a truthy ATOM-key value" do
      # Pathological but must be correct: string key wins (declared precedence),
      # and its false value must not be overridden by the atom-key fallback.
      m = %{"flag" => false, flag: true}
      assert Tree.get(m, "flag") == false
    end
  end
end
