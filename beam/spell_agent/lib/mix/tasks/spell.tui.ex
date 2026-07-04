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

  ## Durable layouts + keymaps (PLAN-024 Wave 4 / FUP-009)

  `--durable` / `-d` makes any layout shadow (`layout/set`) or keybinding
  override (`keymap/bind`, `keymap/define-reaction`) authored THIS launch
  survive to the next one — persisted per-project (via the same durable store
  `Hist` uses, rooted at `.spell/forest` under the current directory). `--fresh`
  starts from the native defaults for this launch WITHOUT discarding a
  previously persisted layout/keymap (the next durable, non-fresh launch still
  sees it):

      mix spell.tui -d              # remember layout/keymap edits across launches
      mix spell.tui -d --fresh      # this launch only: ignore persisted state
  """

  use Mix.Task

  @requirements ["app.start"]

  @switches [freeform: :boolean, durable: :boolean, fresh: :boolean]
  @aliases [f: :freeform, d: :durable]

  @impl Mix.Task
  def run(args) do
    {opts, _rest, _invalid} = OptionParser.parse(args, switches: @switches, aliases: @aliases)
    # Freeform is always-on; the flag is a forward-looking hint (prelude bias),
    # threaded so the launcher can surface UI-editing affordances first.
    SpellAgent.tui(
      freeform: Keyword.get(opts, :freeform, false),
      durable: Keyword.get(opts, :durable, false),
      fresh: Keyword.get(opts, :fresh, false)
    )
  end
end
