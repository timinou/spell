defmodule SpellAgent.Tui.RenderProbeTest do
  @moduledoc """
  Headless render probe (BUG-012 fix C): the agent can re-render a layout node
  to ASCII and see what its widget actually looks like.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{DefaultLayout, LayoutRegistry, RenderProbe, Ui}

  setup do
    default = DefaultLayout.tree(Ui.new(panes: [:tree, :detail], focus: :tree), ["tree", "detail"])

    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default})
      _ -> LayoutRegistry.seed_default(default)
    end

    :ok
  end

  describe "RenderProbe.render/2" do
    test "renders a paragraph-shaped node to a buffer containing its text" do
      node = %{
        "type" => "paragraph",
        "text" => "HELLO-PROBE",
        "block" => %{"type" => "block", "borders" => ["all"]}
      }

      assert {:ok, %{buffer: buffer, width: 80, height: 24}} = RenderProbe.render(node)
      assert buffer =~ "HELLO-PROBE"
    end

    test "renders a split with multiple widget children" do
      node = %{
        "type" => "split",
        "dir" => "horizontal",
        "constraints" => [["fill", 1], ["fill", 1]],
        "children" => [
          %{
            "type" => "paragraph",
            "text" => "LEFT-WIDGET",
            "block" => %{"type" => "block", "borders" => ["all"]}
          },
          %{
            "type" => "paragraph",
            "text" => "RIGHT-WIDGET",
            "block" => %{"type" => "block", "borders" => ["all"]}
          }
        ]
      }

      assert {:ok, %{buffer: buffer}} = RenderProbe.render(node, width: 60, height: 10)
      assert buffer =~ "LEFT-WIDGET"
      assert buffer =~ "RIGHT-WIDGET"
    end

    test "respects custom width and height" do
      node = %{"type" => "paragraph", "text" => "SIZE-TEST"}

      assert {:ok, %{buffer: _buffer, width: 40, height: 12}} =
               RenderProbe.render(node, width: 40, height: 12)
    end

    test "falls back to defaults for invalid dimensions" do
      node = %{"type" => "paragraph", "text" => "FALLBACK"}

      assert {:ok, %{width: 80, height: 24}} =
               RenderProbe.render(node, width: -5, height: "not-a-number")
    end

    test "returns empty_render for a pane-only node" do
      assert {:error, :empty_render} = RenderProbe.render(%{"type" => "pane", "slot" => "tree"})
    end

    test "catches a throwing widget and returns an error tuple" do
      # A sparkline with non-numeric data materializes but raises at draw time.
      node = %{"type" => "sparkline", "data" => ["not", "numbers"]}

      assert {:error, {:render_failed, _message}} = RenderProbe.render(node)
    end
  end

  describe "layout/render tool" do
    test "returns a string-keyed buffer map for a :source node" do
      tools = RenderProbe.tools()
      render = tools["layout/render"]

      result =
        render.(%{
          "source" => %{
            "type" => "paragraph",
            "text" => "TOOL-PROBE",
            "block" => %{"type" => "block", "borders" => ["all"]}
          }
        })

      assert is_binary(result["buffer"])
      assert result["buffer"] =~ "TOOL-PROBE"
      assert result["width"] == 80
      assert result["height"] == 24
    end

    test "accepts :node as an alias for :source" do
      tools = RenderProbe.tools()
      render = tools["layout/render"]

      result = render.(%{"node" => %{"type" => "paragraph", "text" => "NODE-ALIAS"}})
      assert result["buffer"] =~ "NODE-ALIAS"
    end

    test "renders a live slot via :slot" do
      tools = RenderProbe.tools()
      render = tools["layout/render"]

      assert :ok =
               LayoutRegistry.set("status", %{
                 "type" => "paragraph",
                 "slot" => "status",
                 "text" => "LIVE-SLOT-PROBE",
                 "block" => %{"type" => "block", "borders" => ["all"]}
               })

      result = render.(%{"slot" => "status"})
      assert result["buffer"] =~ "LIVE-SLOT-PROBE"
      assert result["width"] == 80
      assert result["height"] == 24
    end

    test "returns an err map for an unknown slot" do
      tools = RenderProbe.tools()
      render = tools["layout/render"]

      assert %{
               "err" =>
                 "unknown slot no-such-slot"
             } = render.(%{"slot" => "no-such-slot"})
    end

    test "returns an err map when neither :slot nor :source is given" do
      tools = RenderProbe.tools()
      render = tools["layout/render"]

      assert %{
               "err" =>
                 "layout/render requires a :slot or :source"
             } = render.(%{"width" => 40})
    end

    test "returns an err map for a pane-only node" do
      tools = RenderProbe.tools()
      render = tools["layout/render"]

      assert %{"err" => message} = render.(%{"source" => %{"type" => "pane", "slot" => "tree"}})
      assert message =~ "no renderable widgets"
      assert message =~ "pane"
    end

    test "returns an err map for a bad/empty node" do
      tools = RenderProbe.tools()
      render = tools["layout/render"]

      assert %{"err" => _} = render.(%{"source" => %{"type" => "unknown_widget_xyz"}})
    end
  end
end
