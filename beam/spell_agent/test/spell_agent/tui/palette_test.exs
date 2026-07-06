defmodule SpellAgent.Tui.PaletteTest do
  @moduledoc """
  FEAT-047 W2 (hardened post-audit): the command palette's state + selection.

  These tests defend the contract that came OUT of the deep review: palette
  state is a dedicated `%Palette{}` struct (App-owned, never `ui.flags` — the
  mind's agent-writable extension point), so it is bounded BY CONSTRUCTION and
  can never be evicted by `Ui.safe_flags`' 32-entry cap. All reads are
  untrusted-safe (bad query/cursor never crash), the cursor clamps to the
  filtered bounds, and a fired row yields a `{:intent, intent, TRUSTED-ctx}`
  resolution built from the row's carried dispatch context — never a
  re-interned display string, and never a non-atom context (which would crash
  `Keys.context_name/1` deeper in dispatch — the audit's Manipura finding).
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.Palette
  alias SpellAgent.Tui.Keymap.Global

  defp rows do
    [
      %{"context" => "global", "chord" => "C-o", "intent" => "app/cockpit", "label" => "cockpit", "dispatch-ctx" => Global},
      %{"context" => "global", "chord" => "C-c", "intent" => "app/quit", "label" => "quit", "dispatch-ctx" => Global},
      %{"context" => "tree", "chord" => "j", "intent" => "nav/next", "label" => "next", "dispatch-ctx" => SpellAgent.Tui.Panes.SpanTree}
    ]
  end

  describe "open/close lifecycle" do
    test "open sets the flag and resets query + cursor; close clears all" do
      opened = Palette.open(Palette.new())
      assert Palette.open?(opened)
      assert Palette.query(opened) == ""
      assert Palette.cursor(opened) == 0

      closed = Palette.close(opened)
      refute Palette.open?(closed)
      assert closed == Palette.new()
    end

    test "a fresh Palette.new/0 is closed by default" do
      refute Palette.open?(Palette.new())
    end

    test "open?/1 is total: a non-Palette value reads as closed, not a crash" do
      refute Palette.open?(nil)
      refute Palette.open?(%{})
    end
  end

  describe "state is a dedicated struct, NOT ui.flags (the audit's fix)" do
    test "Palette carries no dependency on Ui.safe_flags' 32-entry cap" do
      # The whole point: open/append/move never touch a shared, evictable bag.
      # A Palette value is self-contained — bounded by its own fields, not by
      # competing for slots in an agent-writable map.
      p = Palette.new() |> Palette.open() |> Palette.append("x")
      assert %Palette{open?: true, query: "x", cursor: 0} = p
      refute Map.has_key?(p, :flags)
    end
  end

  describe "query editing" do
    test "append extends the query and caps at max_query" do
      long = String.duplicate("a", Palette.max_query() + 20)
      built = Enum.reduce(String.graphemes(long), Palette.open(Palette.new()), &Palette.append(&2, &1))
      assert String.length(Palette.query(built)) == Palette.max_query()
    end

    test "backspace trims the last char and stops at empty" do
      p = Palette.new() |> Palette.open() |> Palette.append("a") |> Palette.append("b")
      assert Palette.query(Palette.backspace(p)) == "a"
      assert Palette.query(p |> Palette.backspace() |> Palette.backspace() |> Palette.backspace()) == ""
    end

    test "query/1 is total: a non-Palette value reads as empty" do
      assert Palette.query(nil) == ""
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

    test "a non-string field in a row is normalized, not passed to a crashing to_string/1" do
      # A live data/keybindings producer is untrusted: a map/tuple value for a
      # field must not reach `to_string/1` (which raises on those). The row is
      # kept (map filter passes) but simply never matches on that field.
      hostile = [%{"context" => "x", "chord" => %{}, "intent" => "y", "label" => "z", "dispatch-ctx" => Global}]
      assert Palette.filter(hostile, "") == hostile
      assert Palette.filter(hostile, "irrelevant") == []
    end
  end

  describe "cursor movement + clamping" do
    test "move clamps to the filtered bounds (never negative, never past end)" do
      p = Palette.open(Palette.new())
      assert Palette.selected_index(Palette.move(p, rows(), -1), rows()) == 0
      far = Enum.reduce(1..10, p, fn _, acc -> Palette.move(acc, rows(), +1) end)
      assert Palette.selected_index(far, rows()) == 2
    end

    test "cursor/1 and selected_index/2 are total on a non-Palette value" do
      assert Palette.cursor(nil) == 0
      assert Palette.selected_index(nil, rows()) == 0
    end

    test "selected_index clamps even if the cursor is stale after the query narrows" do
      # cursor 2 but query narrows to 1 row -> clamps to 0.
      narrowed = Palette.new() |> Palette.open() |> Palette.append("cockpit")
      narrowed = %{narrowed | cursor: 2}
      assert Palette.selected_index(narrowed, rows()) == 0
    end
  end

  describe "resolution — firing a row" do
    test "yields {:intent, intent, TRUSTED-ctx} from the selected row" do
      # Default cursor 0, empty query -> first row (app/cockpit under Global).
      assert {:intent, :"app/cockpit", Global} = Palette.resolution(Palette.open(Palette.new()), rows())
    end

    test "the ctx is the row's carried dispatch-ctx, not a re-interned string" do
      p = Palette.move(Palette.open(Palette.new()), rows(), +2)
      assert {:intent, :"nav/next", SpellAgent.Tui.Panes.SpanTree} = Palette.resolution(p, rows())
    end

    test "an empty result set yields nil (no fire)" do
      p = Palette.new() |> Palette.open() |> Palette.append("z") |> Palette.append("z")
      assert Palette.resolution(p, rows()) == nil
    end

    test "a row with an unknown intent string yields nil (no atom growth)" do
      bad = [%{"context" => "x", "chord" => "z", "intent" => "totally/unheard-of-#{:erlang.unique_integer([:positive])}", "label" => "z", "dispatch-ctx" => Global}]
      assert Palette.resolution(Palette.open(Palette.new()), bad) == nil
    end

    test "a row with a NON-ATOM dispatch-ctx yields nil, not a crash deeper in dispatch" do
      # The audit's Manipura finding: a live data/keybindings producer could emit
      # a string context (e.g. "tree" instead of the module). Real keystrokes can
      # never produce this — only a hostile/buggy live row can — so resolution/2
      # must refuse it here rather than let it reach Keys.context_name/1 (which
      # is is_atom-only and would raise FunctionClauseError).
      hostile = [%{"context" => "x", "chord" => "z", "intent" => "nav/next", "label" => "z", "dispatch-ctx" => "tree"}]
      assert Palette.resolution(Palette.open(Palette.new()), hostile) == nil
    end
  end
end
