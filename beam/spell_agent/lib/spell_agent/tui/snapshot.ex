defmodule SpellAgent.Tui.Snapshot do
  @moduledoc """
  The home for visual snapshot baselines of the gallery scenes (PLAN-347).

  A "snapshot" is the headless `SceneRender.buffer/2` of a scene at a fixed size —
  a plain UTF-8 text file of exactly what the inspector draws for that forest.
  Baselines live as committed `.txt` files under `test/snapshots/`, so a visual
  regression shows up as a readable text diff in code review (no binary blobs, no
  image tooling).

  Flow:

    * `mix spell.gallery --snapshot` calls `write_all/0` to (re)generate every
      baseline — run it intentionally when a render change is expected, then eyeball
      `git diff test/snapshots/` before committing.
    * `SpellAgent.Tui.SnapshotTest` calls `current/1` per scene and asserts it
      equals the committed `read/1` baseline — so an UNINTENDED render change fails
      CI with the offending scene's diff.

  One fixed size (`@width` x `@height`) keeps baselines deterministic. The size is
  generous enough that every shipped scene fits without scrolling, so a snapshot
  captures the whole tree.
  """

  alias SpellAgent.Tui.{Scenes, SceneRender}

  # Fixed, generous render size — every scene fits fully so baselines are stable.
  @width 80
  @height 28

  @doc "Absolute path to the committed snapshots directory."
  @spec dir() :: String.t()
  def dir, do: Path.join([__DIR__, "..", "..", "..", "test", "snapshots"]) |> Path.expand()

  @doc "The baseline file path for a scene name (slugified)."
  @spec path(String.t()) :: String.t()
  def path(scene_name), do: Path.join(dir(), slug(scene_name) <> ".txt")

  @doc "Render a scene to its canonical snapshot string (the regression target)."
  @spec current(map()) :: String.t()
  def current(scene), do: SceneRender.buffer(scene, width: @width, height: @height)

  @doc "Read a committed baseline; `{:error, :missing}` if it was never written."
  @spec read(String.t()) :: {:ok, String.t()} | {:error, :missing}
  def read(scene_name) do
    case File.read(path(scene_name)) do
      {:ok, content} -> {:ok, content}
      {:error, _} -> {:error, :missing}
    end
  end

  @doc """
  (Re)write every scene's baseline to disk and return the list of paths written.
  Intended for `mix spell.gallery --snapshot`, not for tests (tests assert, they
  never write).
  """
  @spec write_all() :: [String.t()]
  def write_all do
    File.mkdir_p!(dir())

    Enum.map(Scenes.all(), fn scene ->
      file = path(scene.name)
      File.write!(file, current(scene))
      file
    end)
  end

  @doc "The render size baselines are captured at, as `{width, height}`."
  @spec size() :: {pos_integer(), pos_integer()}
  def size, do: {@width, @height}

  defp slug(name) do
    name
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9]+/, "-")
    |> String.trim("-")
  end
end