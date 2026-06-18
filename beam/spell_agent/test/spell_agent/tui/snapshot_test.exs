defmodule SpellAgent.Tui.SnapshotTest do
  @moduledoc """
  Visual regression: every gallery scene's headless render must equal its
  committed baseline under `test/snapshots/` (PLAN-347).

  These run `async: true` because `SceneRender.buffer/2` uses a throwaway test
  terminal per call (no shared state). A failure means the rendered tree changed:
  if INTENDED, regenerate with `mix spell.gallery --snapshot` and review the text
  diff; if not, you just caught a regression.

  The baselines, the interactive `mix spell.gallery`, and the perf benchmark all
  render through the SAME `SceneRender` path, so this test and the gallery can
  never silently disagree.
  """

  use ExUnit.Case, async: true

  alias SpellAgent.Tui.{Scenes, Snapshot}

  test "a baseline exists for every scene (run `mix spell.gallery --snapshot`)" do
    missing =
      Scenes.all()
      |> Enum.filter(fn scene -> Snapshot.read(scene.name) == {:error, :missing} end)
      |> Enum.map(& &1.name)

    assert missing == [],
           "missing snapshot baselines for: #{inspect(missing)} — run `mix spell.gallery --snapshot`"
  end

  for scene <- Scenes.all() do
    @scene scene

    test "scene #{scene.name} matches its committed snapshot" do
      case Snapshot.read(@scene.name) do
        {:ok, baseline} ->
          current = Snapshot.current(@scene)

          assert current == baseline, """
          Snapshot mismatch for scene #{inspect(@scene.name)}.

          If this change is intentional, regenerate the baselines:

              mix spell.gallery --snapshot

          then review `git diff test/snapshots/`.

          --- expected (committed baseline) ---
          #{baseline}
          --- actual (current render) ---
          #{current}
          """

        {:error, :missing} ->
          flunk("no baseline for #{inspect(@scene.name)} — run `mix spell.gallery --snapshot`")
      end
    end
  end
end