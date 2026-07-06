defmodule SpellAgent.Tui.KeymapIntrospectTest do
  @moduledoc """
  FEAT-047: the ONE keymap reflection every discoverability surface projects.

  These tests defend the contract the hint bar, help overlay, and command palette
  all depend on: rows reflect the compiled keymaps UNIONED with live registry
  bindings, a live override WINS over the compiled entry, the trusted dispatch
  context is carried (never re-interned from a display string), and the whole
  thing is total + bounded so no surface can be bricked by it.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{Chord, KeymapIntrospect, KeymapRegistry}
  alias SpellAgent.Tui.Keymap.Global
  alias SpellAgent.Tui.Panes.SpanTree

  setup do
    KeymapRegistry.reset()
    :ok
  end

  describe "rows/0 — the reflected binding set" do
    test "reflects the compiled global keymap (chord + intent + human label)" do
      rows = KeymapIntrospect.rows()
      global = Enum.filter(rows, &(&1["context"] == "global"))

      cockpit = Enum.find(global, &(&1["chord"] == "C-o"))
      assert cockpit["intent"] == "app/cockpit"
      assert cockpit["label"] == "cockpit"

      # A pane context's own chords are reflected under its name.
      tree = Enum.filter(rows, &(&1["context"] == "tree"))
      assert Enum.any?(tree, &(&1["chord"] == "l" and &1["label"] == "in"))
    end

    test "carries the TRUSTED dispatch context term (module for a compiled ctx)" do
      row = KeymapIntrospect.rows() |> Enum.find(&(&1["chord"] == "C-o"))
      # The dispatch context is the MODULE, not the display string — so the
      # palette can fire it without String.to_atom on untrusted data.
      assert row["dispatch-ctx"] == Global
    end

    test "a LIVE registry binding WINS over the compiled entry for the same chord" do
      # Rebind C-o (compiled: app/cockpit) to a different intent live.
      KeymapRegistry.bind(:global, Chord.parse("C-o"), :"app/quit")

      row =
        KeymapIntrospect.rows()
        |> Enum.find(&(&1["context"] == "global" and &1["chord"] == "C-o"))

      assert row["intent"] == "app/quit"
    end

    test "a live binding to a NEW chord ADDS a row" do
      KeymapRegistry.bind(:tree, Chord.parse("g"), :"nav/next")

      row =
        KeymapIntrospect.rows()
        |> Enum.find(&(&1["context"] == "tree" and &1["chord"] == "g"))

      assert row["intent"] == "nav/next"
    end

    test "a live binding to a RUNTIME context (no compiled module) is discoverable" do
      # A keymap/bind to a fresh context atom with no compiled keymap/0.
      KeymapRegistry.bind(:my_runtime_pane, Chord.parse("x"), :"custom/act")

      row =
        KeymapIntrospect.rows()
        |> Enum.find(&(&1["context"] == "my_runtime_pane" and &1["chord"] == "x"))

      assert row
      assert row["intent"] == "custom/act"
      # Its dispatch ctx is the bare atom (Keys.dispatch guards Code.ensure_loaded?).
      assert row["dispatch-ctx"] == :my_runtime_pane
    end

    test "is bounded to @max_rows" do
      assert length(KeymapIntrospect.rows()) <= KeymapIntrospect.max_rows()
    end
  end

  describe "label_for/1 — human labels" do
    test "curated overrides win for the poorly-reading intents" do
      assert KeymapIntrospect.label_for("nav/child") == "in"
      assert KeymapIntrospect.label_for("app/reset-layout") == "reset layout"
    end

    test "derives from the last path segment otherwise" do
      assert KeymapIntrospect.label_for("span/expand") == "expand"
      assert KeymapIntrospect.label_for("scroll/down") == "down"
    end

    test "a non-binary intent yields an empty label (total)" do
      assert KeymapIntrospect.label_for(nil) == ""
    end
  end

  describe "context_rows/1 — a single context" do
    test "the SpanTree module and its :tree name reflect the same compiled chords" do
      by_mod = KeymapIntrospect.context_rows(SpanTree)
      assert Enum.any?(by_mod, &(&1["chord"] == "j" and &1["intent"] == "nav/next"))
      # Every row is labeled under the registry name, not the module.
      assert Enum.all?(by_mod, &(&1["context"] == "tree"))
    end
  end
end
