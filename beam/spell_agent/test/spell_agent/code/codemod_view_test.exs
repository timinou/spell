defmodule SpellAgent.Code.CodemodViewTest do
  @moduledoc """
  Contracts for the codemod inspector's data + formatting surface (PLAN-022 S2):
  `Code.dry_run_ops/3` (the non-writing parse -> apply -> unparse -> gate path) and
  `Code.CodemodView` (the pure before/ops/after/verdict renderer the `mix
  spell.codemod` task and a future TUI pane share).

  The snapshot assertions pin the exact rendered facets a reader depends on; the
  dry-run assertions pin the no-write contract (success keeps no file, a rejected
  transform yields a reason, not a partial result).
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Code
  alias SpellAgent.Code.CodemodView

  # The canonical rename-identifier op-list (what an agent's q/rename-id emits).
  defp rename_ops(from, to) do
    [
      %{
        "op" => "update",
        "pattern" => %{"node" => "identifier", "value" => from},
        "template" => %{"node" => "identifier", "value" => to}
      }
    ]
  end

  describe "Code.dry_run_ops/3 — the non-writing preview" do
    test "a valid rename yields after-source + an :ok verdict, no file touched" do
      result = Code.dry_run_ops("def add(x), do: x + 1\n", "elixir", rename_ops("x", "y"))

      assert result.verdict == :ok
      assert result.before == "def add(x), do: x + 1\n"
      assert is_binary(result.after)
      assert result.after =~ "y"
      refute result.after =~ ~r/\bx\b/
      # the op-list is carried through verbatim (the reified, composable data).
      assert result.ops == rename_ops("x", "y")
    end

    test "an unparseable language is a rejected verdict with a reason, after = nil" do
      result = Code.dry_run_ops("def f, do: 1", "no-such-lang", rename_ops("x", "y"))

      assert {:error, _reason} = result.verdict
      assert result.after == nil
    end
  end

  describe "CodemodView.report_text/2 — the rendered report" do
    test "renders all four facets (header, before, ops-as-data, after, verdict)" do
      result = Code.dry_run_ops("def add(x), do: x + 1\n", "elixir", rename_ops("x", "y"))
      text = CodemodView.report_text("(demo)", result)

      # header carries the path + language
      assert text =~ "CODEMOD  (demo)  (elixir)"
      # the four labelled sections are present and ordered
      assert text =~ "BEFORE"
      assert text =~ "OPS (reified data)"
      assert text =~ "AFTER"
      assert text =~ "VERDICT  ok (re-parses clean)"

      # ordering: BEFORE precedes OPS precedes AFTER precedes VERDICT
      assert index(text, "BEFORE") < index(text, "OPS (reified data)")
      assert index(text, "OPS (reified data)") < index(text, "AFTER")
      assert index(text, "AFTER") < index(text, "VERDICT")
    end

    test "the OPS section renders each op's kind + pattern/template form compactly" do
      result = Code.dry_run_ops("def add(x), do: x + 1\n", "elixir", rename_ops("x", "y"))
      text = CodemodView.report_text("(demo)", result)

      assert text =~ "1. update"
      # the compact form_tree rendering: node[value="…"]
      assert text =~ ~s|pattern: identifier[value="x"]|
      assert text =~ ~s|template: identifier[value="y"]|
    end

    test "a rejected codemod renders the reason and an (rejected) AFTER" do
      result = Code.dry_run_ops("def f, do: 1", "no-such-lang", rename_ops("x", "y"))
      text = CodemodView.report_text("bad.ex", result)

      assert text =~ "VERDICT  rejected:"
      assert text =~ "AFTER\n  (rejected"
    end

    test "an empty op-list renders a (no ops) OPS section" do
      # dry_run with no ops re-renders the source (a no-op transform); the view
      # must still render a stable OPS section, not crash on the empty list.
      assert CodemodView.ops_text([]) == "  (no ops)"
    end
  end

  # 0-based index of the first occurrence of `needle` in `haystack`.
  defp index(haystack, needle) do
    [prefix | _] = String.split(haystack, needle, parts: 2)
    String.length(prefix)
  end
end
