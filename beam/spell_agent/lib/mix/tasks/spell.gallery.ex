defmodule Mix.Tasks.Spell.Gallery do
  @shortdoc "Browse the inspector's screens by hand (no iex)"

  @moduledoc """
  Launch the SpellAgent screen gallery (PLAN-347) — a bespoke browser for every
  state the inspector's span-tree pane can render.

  Instead of running a mission, it cycles a curated set of FIXTURE forests
  (`SpellAgent.Tui.Scenes`) through the production `SpanTree` projection + render
  path, so what you see is exactly what the live inspector draws for that state,
  with zero network and zero agent loop.

      mix spell.gallery

  `j`/`k` (or `↑`/`↓`) move between scenes; `n`/`p` move the cursor inside the
  current tree; `l`/`h` expand and collapse the cursor row; `esc`/`q` quit. The
  terminal (alternate screen + raw mode) is restored on exit.

  Like `mix spell.tui`, this is a dedicated task rather than `iex -S mix` because
  the app takes over stdin/stdout and iex would corrupt the display (BUG-489).
  """

  use Mix.Task

  alias SpellAgent.Tui.ScreenGallery

  @requirements ["app.start"]

  @impl Mix.Task
  def run(_args) do
    {:ok, pid} = ScreenGallery.start_link(name: nil)
    ref = Process.monitor(pid)

    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
    end
  end
end