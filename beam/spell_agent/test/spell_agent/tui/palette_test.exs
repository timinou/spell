defmodule SpellAgent.Tui.PaletteTest do
  @moduledoc """
  FEAT-047 W2: the command palette's state + selection logic.

  These tests defend the oracle-gated contract (agent 30): palette state lives in
  bounded `ui.flags`, all reads are untrusted-safe (bad query/cursor never
  crash), the cursor clamps to the filtered bounds, and a fired row yields a
  `{:intent, intent, TRUSTED-ctx}` resolution built from the row's carried
  dispatch context — never a re-interned display string.
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.{Palette, Ui}
  alias SpellAgent.Tui.Keymap.Global

  defp ui, do: Ui.new(focus: :tree, panes: [:prompt, :tree, :detail])

  defp rows do
    [
      %{"context" => "global", "chord" => "C-o", "intent" => "app/cockpit", "label" => "cockpit", "dispatch-ctx" => Global},
      %{"context" => "global", "chord" => "C-c", "intent" => "app/quit", "label" => "quit", "dispatch-ctx" => Global},
      %{"context" => "tree", "chord" => "j", "intent" => "nav/next", "label" => "next", "dispatch-ctx" => SpellAgent.Tui.Panes.SpanTree}
    ]
  end

  describe "open/close lifecycle" do
    test "open sets the flag and resets query + cursor; close clears all" do
      opened = Palette.open(ui())
      assert Palette.open?(opened)
      assert Palette.query(opened) == ""
      assert Palette.cursor(opened) == 0

      closed = Palette.close(opened)
      refute Palette.open?(closed)
      refute Map.has_key?(closed.flags, "palette-query")
      refute Map.has_key?(closed.flags, "palette-cursor")
    end

    test "open? is a STRICT boolean read (a truthy non-true flag is not open)" do
      forged = %{ui() | flags: %{"palette" => "yes"}}
      refute Palette.open?(forged)
    end
  end

  describe "query editing" do
    test "append extends the query and caps at max_query" do
      long = String.duplicate("a", Palette.max_query() + 20)
      built = Enum.reduce(String.graphemes(long), Palette.open(ui()), &Palette.append(&2, &1))
      assert String.length(Palette.query(built)) == Palette.max_query()
    end

    test "backspace trims the last char and stops at empty" do
      p = ui() |> Palette.open() |> Palette.append("a") |> Palette.append("b")
      assert Palette.query(Palette.backspace(p)) == "a"
      assert Palette.query(p |> Palette.backspace() |> Palette.backspace() |> Palette.backspace()) == ""
    end

    test "a non-binary query flag reads as empty (untrusted-safe)" do
      forged = %{ui() | flags: %{"palette" => true, "palette-query" => 123}}
      assert Palette.query(forged) == ""
    end
  end

  describe "filter" do
    test "matches chord, label, intent, or context substring (case-insensitive)" do
      assert Palette.filter(rows(), "cockpit") |> length() == 1
      assert Palette.filter(rows(), "QUIT") |> length() == 1
      assert Palette.filter(rows(), "tree") |> length() == 1
      assert Palette.filter(rows(), "c-") |> length() == 2
    end

    test "an empty query matches everything; a bad rows value yields []" do
      assert Palette.filter(rows(), "") |> length() == 3
      assert Palette.filter("nope", "x") == []
    end

    test "malformed rows are dropped, not crashed" do
      mixed = rows() ++ [42, "str", %{}]
      assert Palette.filter(mixed, "") |> Enum.all?(&is_map/1)
    end
  end

  describe "cursor movement + clamping" do
    test "move clamps to the filtered bounds (never negative, never past end)" do
      p = Palette.open(ui())
      # 3 rows, empty query. Up from 0 stays 0; down past end stays at last.
      assert Palette.selected_index(Palette.move(p, rows(), -1), rows()) == 0
      far = Enum.reduce(1..10, p, fn _, acc -> Palette.move(acc, rows(), +1) end)
      assert Palette.selected_index(far, rows()) == 2
    end

    test "a non-integer cursor flag reads as 0 (untrusted-safe)" do
      forged = %{ui() | flags: %{"palette" => true, "palette-cursor" => "x"}}
      assert Palette.selected_index(forged, rows()) == 0
    end

    test "selected_index clamps even if the flag is out of range for the filter" do
      # cursor 2 but query narrows to 1 row -> clamps to 0.
      narrowed = %{ui() | flags: %{"palette" => true, "palette-query" => "cockpit", "palette-cursor" => 2}}
      assert Palette.selected_index(narrowed, rows()) == 0
    end
  end

  describe "resolution — firing a row" do
    test "yields {:intent, intent, TRUSTED-ctx} from the selected row" do
      # Default cursor 0, empty query -> first row (app/cockpit under Global).
      assert {:intent, :"app/cockpit", Global} = Palette.resolution(Palette.open(ui()), rows())
    end

    test "the ctx is the row's carried dispatch-ctx, not a re-interned string" do
      # Move to the tree row; its ctx must be the pane MODULE.
      p = Palette.move(Palette.open(ui()), rows(), +2)
      assert {:intent, :"nav/next", SpellAgent.Tui.Panes.SpanTree} = Palette.resolution(p, rows())
    end

    test "an empty result set yields nil (no fire)" do
      p = ui() |> Palette.open() |> Palette.append("z") |> Palette.append("z")
      assert Palette.resolution(p, rows()) == nil
    end

    test "a row with an unknown intent string yields nil (no atom growth)" do
      bad = [%{"context" => "x", "chord" => "z", "intent" => "totally/unheard-of-#{:erlang.unique_integer([:positive])}", "label" => "z", "dispatch-ctx" => Global}]
      assert Palette.resolution(Palette.open(ui()), bad) == nil
    end
  end
end
