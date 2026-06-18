defmodule Mix.Tasks.Spell.Tui do
  @shortdoc "Launch the live inspector TUI (no iex)"

  @moduledoc """
  Launch the SpellAgent live inspector TUI (PLAN-345) directly, without iex.

  The TUI takes over the terminal (alternate screen + raw mode) and must be the
  SOLE foreground consumer of stdin/stdout — which is exactly why a dedicated mix
  task exists instead of `iex -S mix` + `SpellAgent.tui()`: iex would keep
  reading stdin and printing its prompt, corrupting the display (BUG-489).

      mix spell.tui

  Type a prompt and press Enter to run a mission; watch the span forest fill in
  live, with the final answer in the header. Press `esc` (or ctrl-c) to quit;
  the terminal is restored on exit.

  This boots the full `:spell_agent` application (so the supervised
  `SpellAgent.Tui.Store`, tool registry, and OAuth holder are running), then
  blocks until you quit.
  """

  use Mix.Task

  @requirements ["app.start"]

  @impl Mix.Task
  def run(_args) do
    SpellAgent.tui()
  end
end
