defmodule SpellAgent.Tui.LayoutDiagnosticTest do
  @moduledoc """
  Path-aware validation diagnostics (PLAN-015, PLAN-017).

  Defends the *unevaluated-form* failure class (BUG-013): a `tmpl::` quasiquote
  freezes every non-~ form as inert CoreAST data, so a bare `(str … ~x …)` (no
  `~` on the `str`) survives `resolve_holes` as a list headed by
  `{:symbol_ref, "str"}` and would otherwise leak to the encoder as an opaque
  "cannot coerce […] into %Text{}". The detector names the cause + the fix.
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.LayoutDiagnostic

  describe "unevaluated-form detection (BUG-013)" do
    # The trace's exact failure: the outer `str` has no `~`, so it freezes as
    # `{:symbol_ref, "str"}` heading a list (the inner ~ hole resolved fine).
    test "a bare (str … ~x …) inside tmpl:: is rejected as unevaluated_form" do
      {:ok, step} =
        PtcRunner.Lisp.run(
          ~S'(tmpl:: {:type "paragraph" :text (str "turn " ~(get data/status :label))})'
        )

      assert {:error, diag} = LayoutDiagnostic.validate(step.return)
      assert diag["reason"] == "unevaluated_form"
      assert diag["path"] == "source.text"
      assert diag["detail"] =~ "str"
      assert diag["detail"] =~ "~(str"
      assert diag["expected"] =~ ":text"
    end

    test "a frozen bare ref (a symbol that was never ~-marked) is caught too" do
      node = %{"type" => "paragraph", "style" => %{"fg" => {:symbol_ref, "data/x"}}}

      assert {:error, diag} = LayoutDiagnostic.validate(node)
      assert diag["reason"] == "unevaluated_form"
      assert diag["path"] == "source.style.fg"
      assert diag["detail"] =~ "data/x"
    end

    # The one-char fix: wrapping the WHOLE call in ~ makes it one deferred hole
    # that evaluates to a string at render. Must be ACCEPTED (regression guard).
    test "the fix — ~(str …) wrapping the whole call — is accepted" do
      {:ok, step} =
        PtcRunner.Lisp.run(
          ~S'(tmpl:: {:type "paragraph" :text ~(str "turn " (get data/status :label))})'
        )

      assert :ok = LayoutDiagnostic.validate(step.return)
    end

    test "a static literal node produces no false positive" do
      assert :ok = LayoutDiagnostic.validate(%{"type" => "paragraph", "text" => "plain"})
    end
  end

  describe "data-driven split children (PLAN-027 M6)" do
    # A split whose children come from a SPLICE hole over live data (the cockpit's
    # per-session card grid) resolves to ZERO children against the empty probe
    # env. That is a legitimate runtime state (no data yet), NOT a malformed
    # layout — the validator must ACCEPT it rather than reject the whole layout.
    test "a split with splice-hole children validates even when empty against the probe env" do
      {:ok, step} =
        PtcRunner.Lisp.run(
          ~S'(tmpl:: {"type" "split" "dir" "horizontal" "constraints" [] "children" ~@(map (fn [s] {"type" "block" "title" (get s "id")}) data/items)})'
        )

      assert :ok = LayoutDiagnostic.validate(step.return)
    end

    test "a split with a STATIC empty children list is STILL rejected (real authoring bug)" do
      assert {:error, %{"reason" => "empty_children"}} =
               LayoutDiagnostic.validate(%{"type" => "split", "dir" => "horizontal", "children" => []})
    end

    test "a split nesting a splice-hole child validates (the cockpit's outer+grid shape)" do
      {:ok, step} =
        PtcRunner.Lisp.run(
          ~S'(tmpl:: {"type" "split" "dir" "vertical" "constraints" [["length" 1] ["min" 0]] "children" [{"type" "paragraph" "text" "header"} {"type" "split" "dir" "horizontal" "constraints" [] "children" ~@(map (fn [s] {"type" "block" "title" (get s "id")}) data/items)}]})'
        )

      assert :ok = LayoutDiagnostic.validate(step.return)
    end
  end
end
