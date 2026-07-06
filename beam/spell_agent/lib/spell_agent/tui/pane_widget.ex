defmodule SpellAgent.Tui.PaneWidget do
  @moduledoc """
  Turn a pane's render DESCRIPTOR into a concrete ExRatatui widget (PLAN-025 W3,
  FEAT-041).

  A built-in pane's `view/1` returns a descriptor tuple (`{:list, desc}`,
  `{:detail, desc}`, `{:history, desc}`) — the WHAT to show, decoupled from the
  ExRatatui widget types. This module is the last mile: descriptor + rect ->
  `{widget, rect}`. It is a PURE function of the descriptor and the current theme
  (no session state, no side effects), extracted verbatim from the former
  `SpellAgent.Tui.App` god-module so the widget-construction policy is testable in
  isolation and the App shell shrinks to its GenServer responsibilities.

  (Distinct from `SpellAgent.Tui.Materialize`, which coerces a freeform PTC map
  into a widget — that is the agent-authored render path; this is the built-in
  inspector pane path.)

  A descriptor the module does not recognize passes through unchanged
  (`{widget, rect}`), so a pane may still hand back a ready-made widget.
  """

  alias ExRatatui.Style
  alias ExRatatui.Widgets.{Block, List, Paragraph}
  alias SpellAgent.Tui.ThemeRegistry

  @typedoc "A pane descriptor or a ready widget, paired with its target rect."
  @type placement :: {term(), term()}

  @doc """
  Materialize one `{descriptor, rect}` placement into `{widget, rect}`.

  Recognizes the `:list`, `:detail`, and `:history` descriptor shapes; anything
  else is returned unchanged.
  """
  @spec run(placement()) :: placement()
  def run({{:list, desc}, rect}) do
    items = Enum.map(desc.lines, &style_line/1)

    widget = %List{
      items: items,
      block: %Block{
        title: " #{desc.title} ",
        borders: [:all],
        border_type: :rounded,
        border_style: border_style_for(desc.focused?)
      },
      highlight_style: %Style{modifiers: [:bold]},
      selected: select_index(desc, length(items))
    }

    {widget, rect}
  end

  # Detail.view returns a {:detail, %{title, body, scroll, focused?}} descriptor;
  # turn it into a scrollable, wrapped Paragraph (the "see inside" pane).
  def run({{:detail, desc}, rect}) do
    focus_tag = if desc.focused?, do: " ●", else: ""

    widget = %Paragraph{
      text: desc.body,
      wrap: true,
      scroll: {desc.scroll, 0},
      style: %Style{fg: :white},
      block: %Block{
        title: " #{desc.title}#{focus_tag} ",
        borders: [:all],
        border_type: :rounded,
        border_style: border_style_for(desc.focused?)
      }
    }

    {widget, rect}
  end

  # The history pane (PLAN-003 SEAM 3): a durable user<->assistant scrollback,
  # rendered as a scrollable Paragraph (NIF-free, same contract as Detail).
  def run({{:history, desc}, rect}) do
    focus_tag = if desc.focused?, do: " ●", else: ""

    text =
      if desc.empty? do
        "(no history yet — run a mission; it persists across runs and reopen)"
      else
        Enum.map_join(desc.lines, "\n", fn
          %{role: :user, text: t} -> "› you  " <> t
          %{role: :assistant, text: t} -> "‹ agent " <> t
        end)
      end

    widget = %Paragraph{
      text: text,
      wrap: true,
      scroll: {desc.scroll, 0},
      style: %Style{fg: :white},
      block: %Block{
        title: " history#{focus_tag} ",
        borders: [:all],
        border_type: :rounded,
        border_style: border_style_for(desc.focused?)
      }
    }

    {widget, rect}
  end

  def run({widget, rect}), do: {widget, rect}

  @doc "Border style for a pane block, keyed on focus (uses the live theme)."
  @spec border_style_for(boolean()) :: Style.t()
  def border_style_for(true) do
    theme = ThemeRegistry.theme()
    %Style{fg: theme.border_focused, modifiers: [:bold]}
  end

  def border_style_for(false) do
    theme = ThemeRegistry.theme()
    %Style{fg: theme.border}
  end

  # `List.selected` MUST be nil or a valid 0-based index; an empty list has no
  # selection (else ExRatatui raises at render).
  defp select_index(_desc, 0), do: nil
  defp select_index(%{focused?: true, cursor: c}, count), do: c |> max(0) |> min(count - 1)
  defp select_index(_desc, _count), do: nil

  defp style_line(%{text: text, status: status}) do
    %ExRatatui.Text.Line{
      spans: [%ExRatatui.Text.Span{content: text, style: %Style{fg: status_color(status)}}]
    }
  end

  defp status_color(:ok), do: :green
  defp status_color(:error), do: :red
  defp status_color(_), do: :yellow
end
