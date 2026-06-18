defmodule Mix.Tasks.Spell.Gallery do
  @shortdoc "Browse the inspector's screens by hand (no iex)"

  @moduledoc """
  Launch the SpellAgent screen gallery (PLAN-347) — a bespoke browser for every
  state the inspector's span-tree pane can render.

  Instead of running a mission, it cycles a curated set of FIXTURE forests
  (`SpellAgent.Tui.Scenes`) through the production `SpanTree` projection + render
  path, so what you see is exactly what the live inspector draws for that state,
  with zero network and zero agent loop.

      mix spell.gallery              # interactive browser
      mix spell.gallery --snapshot   # (re)write the visual baselines, then exit

  `j`/`k` (or `↑`/`↓`) move between scenes; `n`/`p` move the cursor inside the
  current tree; `l`/`h` expand and collapse the cursor row; `esc`/`q` quit. The
  terminal (alternate screen + raw mode) is restored on exit.

  `--snapshot` does not open the UI: it renders every scene headless through the
  same `SceneRender` path and writes the committed baselines under
  `test/snapshots/`, which `SpellAgent.Tui.SnapshotTest` asserts against. Run it
  only when a render change is intended, then review the text diff.

  Like `mix spell.tui`, this is a dedicated task rather than `iex -S mix` because
  the app takes over stdin/stdout and iex would corrupt the display (BUG-489).
  """

  use Mix.Task

  alias SpellAgent.Tui.{ScreenGallery, Snapshot}

  @requirements ["app.start"]

  @impl Mix.Task
  def run(args) do
    case args do
      ["--snapshot" | _] -> snapshot()
      _ -> browse()
    end
  end

  # Regenerate every scene's visual baseline, then print what was written so the
  # operator can eyeball `git diff test/snapshots/` before committing.
  defp snapshot do
    {w, h} = Snapshot.size()
    paths = Snapshot.write_all()

    Mix.shell().info("Wrote #{length(paths)} snapshot baseline(s) at #{w}x#{h}:")
    for p <- paths, do: Mix.shell().info("  #{Path.relative_to_cwd(p)}")
    Mix.shell().info("\nReview `git diff test/snapshots/` before committing.")
  end

  # Launch the interactive gallery and block until the operator quits it.
  defp browse do
    {:ok, pid} = ScreenGallery.start_link(name: nil)
    ref = Process.monitor(pid)

    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
    end
  end
end