defmodule SpellAgent.Tui.FreeformTest do
  @moduledoc """
  The freeform render mirror (PLAN-009): Reflect -> Materialize -> Surface, plus
  the view/ builders through the REAL PtcRunner sandbox the agent uses.

  These defend the load-bearing contracts of the layout-as-data thesis:
    * reflection yields the widget vocabulary with NO drift (the registry is the
      ex_ratatui struct set),
    * a PTC map coerces to a real %Widget{} (incl. nested style/block + enum atoms
      that are only interned via the typespec harvest),
    * a layout TREE renders to a non-empty buffer through the existing Bridge path,
    * unknown/garbage degrades (never raises) — the failure-ladder precondition,
    * the view/ namespace resolves through PtcRunner.Lisp.run (the agent path).
  """
  use ExUnit.Case, async: true

  alias ExRatatui.Layout.Rect
  alias SpellAgent.Tui.{Materialize, Reflect, Surface, View}

  describe "Reflect — the no-drift registry" do
    test "reflects the core widgets from ex_ratatui structs" do
      names = Reflect.names()
      # A representative spread; if ex_ratatui renames/removes one this breaks
      # loudly, which is the point — the registry IS the struct set.
      for w <- ~w(paragraph list block table gauge style) do
        assert w in names, "expected #{w} in reflected registry"
      end
    end

    test "an entry carries the module + struct field defaults" do
      {:ok, entry} = Reflect.fetch("paragraph")
      assert entry.module == ExRatatui.Widgets.Paragraph
      assert :text in entry.fields
      assert entry.defaults[:alignment] == :left
    end

    test "harvests enum atoms from typespecs (interns non-default enum values)" do
      # :rounded is NOT a struct default (default is :plain) — only the typespec
      # harvest interns it, which Materialize's existing-atom coercion needs.
      assert :rounded in Reflect.enum_atoms()
      assert :bottom_to_top in Reflect.enum_atoms()
    end

    test "reflects the Theme palette slots" do
      slots = Reflect.theme_slots()
      assert :border in slots
      assert :danger in slots
    end
  end

  describe "Materialize — PTC map -> %Widget{}" do
    test "builds a paragraph with nested style coerced to %Style{}" do
      s =
        Materialize.to_struct(%{
          "type" => "paragraph",
          "text" => "hi",
          "style" => %{"fg" => "green", "modifiers" => ["bold"]}
        })

      assert %ExRatatui.Widgets.Paragraph{} = s
      assert s.text == "hi"
      assert s.style.fg == :green
      assert s.style.modifiers == [:bold]
    end

    test "recurses a nested block via its own type tag, coercing enum atoms" do
      s =
        Materialize.to_struct(%{
          "type" => "paragraph",
          "text" => "x",
          "block" => %{
            "type" => "block",
            "title" => "T",
            "borders" => ["all"],
            "border_type" => "rounded"
          }
        })

      assert %ExRatatui.Widgets.Block{} = s.block
      assert s.block.borders == [:all]
      assert s.block.border_type == :rounded
    end

    test "coerces an rgb color map and an indexed color map" do
      s =
        Materialize.to_struct(%{
          "type" => "style",
          "fg" => %{"type" => "rgb", "r" => 1, "g" => 2, "b" => 3}
        })

      assert s.fg == {:rgb, 1, 2, 3}

      s2 =
        Materialize.to_struct(%{"type" => "style", "fg" => %{"type" => "indexed", "value" => 42}})

      assert s2.fg == {:indexed, 42}
    end

    test "an unknown widget type degrades to an error tuple (never raises)" do
      assert {:error, {:unknown_widget, "nonsense"}} =
               Materialize.to_struct(%{"type" => "nonsense"})
    end

    test "an unknown enum value falls back to the field default (no intern, no crash)" do
      # "no_such_border" names no existing atom -> default :plain kept.
      s = Materialize.to_struct(%{"type" => "block", "border_type" => "no_such_border_xyz"})
      assert s.border_type == :plain
    end

    test "an already-built struct passes through (idempotent compose)" do
      p = %ExRatatui.Widgets.Paragraph{text: "native"}
      assert Materialize.to_struct(p) == p
    end

    # BUG-008: a NILABLE struct-typed field (default nil) must still coerce a bare
    # nested map to the right struct. Sparkline's `:style` defaults to nil (unlike
    # Paragraph's `%Style{}`), so the old default-driven coercion left the raw map
    # in place -> the Bridge raised at draw time and the whole frame was dropped.
    test "coerces a nilable struct field (Sparkline.style) despite a nil default" do
      s =
        Materialize.to_struct(%{
          "type" => "sparkline",
          "data" => [1, 2, 3],
          "style" => %{"fg" => "magenta", "modifiers" => ["bold"]}
        })

      assert %ExRatatui.Widgets.Sparkline{} = s
      assert %ExRatatui.Style{} = s.style
      assert s.style.fg == :magenta
      assert s.style.modifiers == [:bold]
    end

    test "a coerced nilable-style widget actually ENCODES through the Bridge" do
      s =
        Materialize.to_struct(%{
          "type" => "sparkline",
          "data" => [1, 2, 3],
          "style" => %{"fg" => "magenta"}
        })

      # The render contract: the Bridge accepts it without raising. This is the
      # exact call that crashed live (encode_style expected %Style{}, got a map).
      assert ExRatatui.Bridge.encode_command({s, %Rect{x: 0, y: 0, width: 10, height: 3}})
    end

    test "Reflect harvests struct-typed fields from typespecs (incl. nilable)" do
      # The no-drift source of the fix: the field->struct map comes from the
      # @type t spec, so a nilable `style: Style.t() | nil` is still known.
      assert Reflect.field_structs("sparkline")[:style] == ExRatatui.Style
      assert Reflect.field_structs("paragraph")[:block] == ExRatatui.Widgets.Block
    end
  end

  describe "Surface — layout tree -> placements -> buffer" do
    test "a nested split renders every leaf into the buffer" do
      tree = %{
        "type" => "split",
        "dir" => "vertical",
        "constraints" => [["length", 3], ["min", 0]],
        "children" => [
          %{
            "type" => "paragraph",
            "text" => "HEADER",
            "block" => %{"type" => "block", "borders" => ["all"]}
          },
          %{
            "type" => "split",
            "dir" => "horizontal",
            "constraints" => [["percentage", 50], ["percentage", 50]],
            "children" => [
              %{"type" => "list", "items" => ["a", "b"], "selected" => 0},
              %{"type" => "paragraph", "text" => "RIGHT"}
            ]
          }
        ]
      }

      buf = render_to_buffer(tree, 40, 10)
      assert buf =~ "HEADER"
      assert buf =~ "RIGHT"
      assert buf =~ "a"
    end

    test "a split yields one placement per leaf" do
      tree = %{
        "type" => "split",
        "dir" => "horizontal",
        "constraints" => [["fill", 1], ["fill", 1]],
        "children" => [
          %{"type" => "paragraph", "text" => "L"},
          %{"type" => "paragraph", "text" => "R"}
        ]
      }

      placements = Surface.render(tree, %Rect{x: 0, y: 0, width: 20, height: 4})
      assert length(placements) == 2
    end

    test "a garbage subtree is skipped, not raised (failure-ladder precondition)" do
      tree = %{
        "type" => "split",
        "dir" => "vertical",
        "constraints" => [["min", 0], ["min", 0]],
        "children" => [
          %{"type" => "paragraph", "text" => "GOOD"},
          %{"type" => "nonsense_widget"}
        ]
      }

      placements = Surface.render(tree, %Rect{x: 0, y: 0, width: 20, height: 6})
      # only the good leaf survives; the bad one contributes nothing.
      assert length(placements) == 1
      assert {%ExRatatui.Widgets.Paragraph{text: "GOOD"}, _} = hd(placements)
    end
  end

  describe "view/ namespace through the real PtcRunner sandbox" do
    test "a view/ program builds a renderable tree" do
      src = """
      (view/split {:dir "vertical" :constraints [["length" 3] ["min" 0]]
        :children [
          (view/paragraph {:text "PTC" :block {:type "block" :borders ["all"]}})
          (view/list {:items ["x" "y"] :selected 1})]})
      """

      assert {:ok, step} = PtcRunner.Lisp.run(src, tools: View.tools(), caller: :in_process_v1)
      buf = render_to_buffer(step.return, 30, 8)
      assert buf =~ "PTC"
      assert buf =~ "x"
    end

    test "view/ builders are reflected one-per-widget" do
      tools = View.tools()
      assert Map.has_key?(tools, "view/paragraph")
      assert Map.has_key?(tools, "view/list")
      assert Map.has_key?(tools, "view/split")
      assert Map.has_key?(tools, "theme/set")
    end
  end

  # ---- helpers ----

  defp render_to_buffer(tree, w, h) do
    rect = %Rect{x: 0, y: 0, width: w, height: h}
    terminal = ExRatatui.init_test_terminal(w, h)

    try do
      :ok = ExRatatui.draw(terminal, Surface.render(tree, rect))
      ExRatatui.get_buffer_content(terminal)
    after
      ExRatatui.Native.restore_terminal(terminal)
    end
  end
end
