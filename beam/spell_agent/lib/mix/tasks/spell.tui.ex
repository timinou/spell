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

  ## Freeform self-editing (PLAN-009)

  The TUI is layout-as-data: the agent can reshape any slot of the live screen by
  calling `view/`/`layout/`/`theme/`/`lens/` from a PTC program. This capability
  is GENERALLY AVAILABLE — always on, no flag. The `--freeform` / `-f` switch is
  accepted for discoverability (and to bias the prelude toward UI self-editing),
  but the render mirror is wired unconditionally:

      mix spell.tui            # freeform capability is live
      mix spell.tui -f         # same; explicit intent (a hint, not a gate)
  """

  use Mix.Task

  @requirements ["app.start"]

  @switches [freeform: :boolean]
  @aliases [f: :freeform]

  @impl Mix.Task
  def run(args) do
    {opts, _rest, _invalid} = OptionParser.parse(args, switches: @switches, aliases: @aliases)
    # Freeform is always-on; the flag is a forward-looking hint (prelude bias),
    # threaded so the launcher can surface UI-editing affordances first.
    SpellAgent.tui(freeform: Keyword.get(opts, :freeform, false))
  end
end
