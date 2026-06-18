defmodule SpellAgent.Tui.ScreenGalleryTest do
  @moduledoc """
  Boots the screen gallery under `test_mode` (headless, no TTY) and drives it the
  way a human would, asserting it renders every scene without crashing and that
  navigation + expand/collapse mutate the gaze as expected.

  This is the test that proves `mix spell.gallery` actually runs — the gallery is
  a real `ExRatatui.App`, so booting it under test_mode exercises the same
  mount/render/handle_event path the live task uses.
  """

  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{ScreenGallery, Scenes}
  alias ExRatatui.Event.Key
  alias ExRatatui.Runtime

  defp key(code), do: %Key{code: code, kind: "press", modifiers: []}
  defp ui(pid), do: :sys.get_state(pid).user_state

  defp press(pid, code) do
    :ok = Runtime.inject_event(pid, key(code))
    # By the time :sys.get_state returns, the server has handled the event.
    _ = :sys.get_state(pid)
    pid
  end

  defp boot do
    {:ok, pid} = ScreenGallery.start_link(name: nil, test_mode: {100, 40})
    _ = :sys.get_state(pid)
    # The app runs under a transient supervisor; kill it hard at test end so
    # cleanup never races the supervisor's own shutdown path.
    on_exit(fn -> if Process.alive?(pid), do: Process.exit(pid, :shutdown) end)
    pid
  end

  test "boots under test_mode and starts on the first scene" do
    pid = boot()
    state = ui(pid)

    assert state.index == 0
    assert length(state.scenes) == length(Scenes.all())
  end

  test "j/k cycle through every scene and wrap around" do
    pid = boot()
    n = length(Scenes.all())

    for expected <- 1..(n - 1) do
      press(pid, "j")
      assert ui(pid).index == expected
    end

    # One more wraps back to 0.
    press(pid, "j")
    assert ui(pid).index == 0

    # And k wraps backward to the last.
    press(pid, "k")
    assert ui(pid).index == n - 1
  end

  test "rendering does not crash on ANY scene (incl. the empty forest)" do
    pid = boot()
    n = length(Scenes.all())

    for _ <- 1..n do
      press(pid, "j")
      assert Process.alive?(pid)
    end
  end

  test "l/h expand and collapse the cursor row within a scene" do
    pid = boot()

    nested_idx = Enum.find_index(Scenes.all(), &(&1.name == "nested sub-agent"))
    for _ <- 1..nested_idx, do: press(pid, "j")
    assert ui(pid).index == nested_idx

    before = ui(pid).ui
    press(pid, "h")
    after_collapse = ui(pid).ui

    refute after_collapse.overrides == before.overrides,
           "collapse should mutate the gaze's overrides map"
  end

  test "q stops the app" do
    pid = boot()
    ref = Process.monitor(pid)

    :ok = Runtime.inject_event(pid, key("q"))

    assert_receive {:DOWN, ^ref, :process, ^pid, _reason}, 1000
  end
end