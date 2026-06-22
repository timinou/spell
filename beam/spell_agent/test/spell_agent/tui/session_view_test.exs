defmodule SpellAgent.Tui.SessionViewTest do
  @moduledoc """
  The pure formatter shared by the browser TUI and the stdout dumps (PLAN-010,
  C6). Asserts the line CONTRACT both surfaces depend on: live marker, summary
  selection, disclosure glyph, and depth-indented interior rendering.
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Tui.SessionView

  defp row(over) do
    Map.merge(
      %{
        session_id: "sess_abcdef123456",
        prompt: nil,
        model: nil,
        t0: 0,
        turns: 0,
        cost: %{input: 0, output: 0, total: 0},
        live?: false,
        recorded?: true
      },
      over
    )
  end

  defp noderow(over) do
    Map.merge(
      %{
        node_id: "n1",
        seq: 1,
        kind: :turn,
        status: :ok,
        prompt: nil,
        form_src: nil,
        say: nil,
        result: nil,
        tokens: nil,
        tools_defined: [],
        has_interior?: false
      },
      over
    )
  end

  test "list_lines marks live sessions and includes turns + cost" do
    [line] =
      SessionView.list_lines([row(%{live?: true, turns: 3, cost: %{total: 42, input: 0, output: 0}})])

    assert line.text =~ "●"
    assert line.text =~ "live"
    assert line.text =~ "3t 42tok"
    assert line.status == :ok
  end

  test "list_lines marks past sessions with a hollow dot" do
    [line] = SessionView.list_lines([row(%{live?: false})])
    assert line.text =~ "○"
    assert line.status == :neutral
  end

  test "list_lines empty state never renders blank" do
    assert [%{kind: :empty}] = SessionView.list_lines([])
  end

  test "trace summary prefers prompt, then form_src, then say, then result" do
    assert [%{text: t}] = SessionView.trace_lines([noderow(%{prompt: "the ask"})])
    assert t =~ "» the ask"

    assert [%{text: t2}] = SessionView.trace_lines([noderow(%{form_src: "(tool/edit {})"})])
    assert t2 =~ "(tool/edit {})"

    assert [%{text: t3}] = SessionView.trace_lines([noderow(%{say: "answered"})])
    assert t3 =~ "answered"

    assert [%{text: t4}] = SessionView.trace_lines([noderow(%{result: "res"})])
    assert t4 =~ "res"
  end

  test "trace node carries status into the line and an error glyph" do
    [line] = SessionView.trace_lines([noderow(%{status: :error, form_src: "x"})])
    assert line.status == :error
    assert line.text =~ "✗"
  end

  test "a turn with an interior shows a collapsed glyph when not expanded" do
    [line] = SessionView.trace_lines([noderow(%{has_interior?: true, form_src: "x"})], %{})
    assert line.text =~ "▸"
  end

  test "an expanded turn renders its interior depth-indented under it" do
    interior = [
      %{depth: 0, kind: :run, name: "root", status: :ok, tokens: nil},
      %{depth: 1, kind: :tool, name: "edit", status: :error, tokens: nil}
    ]

    lines = SessionView.trace_lines([noderow(%{has_interior?: true, form_src: "x"})], %{"n1" => interior})

    assert [head, run_line, tool_line] = lines
    assert head.text =~ "▾"
    assert run_line.text =~ "run root"
    assert tool_line.text =~ "tool edit"
    assert tool_line.status == :error
    # deeper interior rows are indented further than shallower ones
    assert leading_spaces(tool_line.text) > leading_spaces(run_line.text)
  end

  test "trace empty state never renders blank" do
    assert [%{kind: :empty}] = SessionView.trace_lines([])
  end

  test "to_text joins line texts with newlines" do
    text = SessionView.to_text([%{text: "a"}, %{text: "b"}])
    assert text == "a\nb"
  end

  defp leading_spaces(s), do: String.length(s) - String.length(String.trim_leading(s))
end
