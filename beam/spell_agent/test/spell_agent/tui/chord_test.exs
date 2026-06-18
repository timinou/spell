defmodule SpellAgent.Tui.ChordTest do
  @moduledoc "Unit tests for the Chord atom (PLAN-346 W1)."
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.Chord
  alias ExRatatui.Event.Key

  describe "from_event/1" do
    test "reads modifiers (the field app.ex's dead ctrl-c clause ignored)" do
      assert Chord.from_event(%Key{code: "j", modifiers: ["ctrl"]}) == %Chord{key: "j", mods: [:ctrl]}
      assert Chord.from_event(%Key{code: "c", modifiers: ["ctrl"]}) == %Chord{key: "c", mods: [:ctrl]}
    end

    test "a plain key has no mods" do
      assert Chord.from_event(%Key{code: "up", modifiers: []}) == %Chord{key: "up", mods: []}
    end

    test "drops unmodeled modifiers (super/hyper/meta) so it still equals a parsed chord" do
      assert Chord.from_event(%Key{code: "x", modifiers: ["ctrl", "super"]}) == Chord.parse("C-x")
    end

    test "mods are sorted canonically regardless of event order" do
      a = Chord.from_event(%Key{code: "tab", modifiers: ["shift", "ctrl"]})
      b = Chord.from_event(%Key{code: "tab", modifiers: ["ctrl", "shift"]})
      assert a == b
      assert a.mods == [:ctrl, :shift]
    end
  end

  describe "parse/1" do
    test "single modifier" do
      assert Chord.parse("C-j") == %Chord{key: "j", mods: [:ctrl]}
    end

    test "no modifier" do
      assert Chord.parse("esc") == %Chord{key: "esc", mods: []}
    end

    test "multiple modifiers, canonically sorted" do
      assert Chord.parse("C-S-tab") == %Chord{key: "tab", mods: [:ctrl, :shift]}
      assert Chord.parse("S-C-tab") == Chord.parse("C-S-tab")
    end

    test "alt sigil M maps to :alt" do
      assert Chord.parse("M-x") == %Chord{key: "x", mods: [:alt]}
    end

    test "literal hyphen key" do
      assert Chord.parse("-") == %Chord{key: "-", mods: []}
      assert Chord.parse("C--") == %Chord{key: "-", mods: [:ctrl]}
    end

    test "raises on an unknown sigil" do
      assert_raise ArgumentError, fn -> Chord.parse("X-j") end
    end

    test "raises on a malformed chord with an empty key (typo), not silently binding hyphen" do
      assert_raise ArgumentError, fn -> Chord.parse("") end
      assert_raise ArgumentError, fn -> Chord.parse("C-") end
      assert_raise ArgumentError, fn -> Chord.parse("esc-") end
    end

    test "literal-hyphen key with modifiers (C--, C-M--)" do
      assert Chord.parse("C--") == %Chord{key: "-", mods: [:ctrl]}
      assert Chord.parse("C-M--") == %Chord{key: "-", mods: [:alt, :ctrl]}
    end
  end

  describe "to_string/1 round-trips with parse/1" do
    for s <- ["C-j", "C-k", "esc", "C-S-tab", "M-x", "up", "down"] do
      test "#{s}" do
        assert Chord.to_string(Chord.parse(unquote(s))) == unquote(s)
      end
    end
  end

  test "structurally-equal chords are == (usable as map keys)" do
    m = %{Chord.parse("C-l") => :"span/expand"}
    assert m[Chord.from_event(%Key{code: "l", modifiers: ["ctrl"]})] == :"span/expand"
  end
end
