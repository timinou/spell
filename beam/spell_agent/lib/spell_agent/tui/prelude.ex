defmodule SpellAgent.Tui.Prelude do
  @moduledoc """
  The freeform-TUI prelude (PLAN-009) — the compact, reflected teaching surface
  that tells the agent it can reshape its own UI.

  Two halves, exactly as the no-drift thesis requires:

    * a STATIC frame (`priv/prompts/freeform_tui.md`) — the prose + worked
      examples, authored once, loaded at compile via `@external_resource`.
    * a GENERATED widget table — one row per reflected ex_ratatui widget, built
      from `SpellAgent.Tui.Reflect` at RUNTIME so a widget/field added upstream
      appears in the prelude automatically (the same reflection that powers
      `Materialize`). No hand-maintained list, no drift.

  `text/0` returns the assembled prelude for `SpellAgent.Session` to append to the
  system prompt. Kept tight: prose frame + a builder table (name + key fields) +
  the theme slot names.
  """

  alias SpellAgent.Tui.Reflect

  # The static prose frame, loaded at compile (AGENTS.md: static prompt text lives
  # in .md files, imported — never an inline heredoc).
  @external_resource Path.join([
                       :code.priv_dir(:spell_agent) |> to_string(),
                       "prompts",
                       "freeform_tui.md"
                     ])
  @frame File.read!(
           Path.join([:code.priv_dir(:spell_agent) |> to_string(), "prompts", "freeform_tui.md"])
         )

  @doc "The assembled freeform prelude (static frame + reflected widget/theme tables)."
  @spec text() :: String.t()
  def text do
    @frame <> "\n\n" <> widget_table() <> "\n\n" <> theme_line()
  end

  @doc "Just the static frame (no reflected tables) — for a terse surface."
  @spec frame() :: String.t()
  def frame, do: @frame

  # A compact, generated reference: every `view/<name>` builder + its key fields,
  # reflected from the widget structs. Capped field list keeps it scannable.
  defp widget_table do
    rows =
      Reflect.names()
      |> Enum.map(fn name ->
        fields =
          case Reflect.fetch(name) do
            {:ok, %{fields: f}} ->
              f |> Enum.map(&Atom.to_string/1) |> Enum.take(8) |> Enum.join(" ")

            :error ->
              ""
          end

        "  view/#{name}  —  #{fields}"
      end)

    "Builders (reflected from ex_ratatui — `view/<name>`, key fields):\n" <>
      Enum.join(rows, "\n")
  end

  defp theme_line do
    slots = Reflect.theme_slots() |> Enum.map(&Atom.to_string/1) |> Enum.sort() |> Enum.join(" ")
    "Theme slots (`theme/set {:slot \"<slot>\" :fg \"<color>\"}`): " <> slots
  end
end
