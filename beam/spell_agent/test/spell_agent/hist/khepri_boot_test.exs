defmodule SpellAgent.Hist.Store.KhepriBootTest do
  @moduledoc """
  The boot child's SAFETY contract: app start never depends on Khepri.

  `KhepriBoot` exists only to close the gap that `Khepri.start/1` had no
  production caller. Its load-bearing behaviour is the DEGRADATION path: when the
  configured store is not Khepri (tests, headless runs), or when Khepri cannot
  boot, the child returns `:ignore` so the supervision tree continues unaffected.
  That `:ignore` is what preserves the documented Application posture — a sick or
  absent store must never change a mission's outcome, never crash the app.

  The positive path (store == Khepri -> boot -> {:ok, _}) is a thin delegation to
  `Khepri.start/1`, whose on-disk round-trip is already proven by
  `store_khepri_test.exs`; we do not re-boot a second Ra system here.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store.{Khepri, KhepriBoot, Memory}

  # The configured store drives the branch in init/1; capture it at runtime in
  # setup and restore it on exit so this test cannot leak its env into siblings.
  setup do
    saved = Application.get_env(:spell_agent, SpellAgent.Hist, store: Memory)
    on_exit(fn -> Application.put_env(:spell_agent, SpellAgent.Hist, saved) end)
    :ok
  end

  test "returns :ignore when the configured store is Memory (no Khepri boot)" do
    Application.put_env(:spell_agent, SpellAgent.Hist, store: Memory)
    # No Ra system is started, and the child does not register its name, so the
    # supervision tree would simply skip it. start_link/1 surfaces that as :ignore.
    assert KhepriBoot.start_link([]) == :ignore
  end

  test "returns :ignore when Khepri is configured but cannot boot" do
    # Point Khepri at a path whose parent is a regular file (/dev/null is a char
    # device, not a directory), so Khepri.start/1's File.mkdir_p!/1 RAISES. The
    # child must translate that raise into :ignore, not crash the supervisor.
    Application.put_env(:spell_agent, SpellAgent.Hist, store: Khepri)

    assert KhepriBoot.start_link(data_dir: "/dev/null/cannot-exist-here") == :ignore
  end
end
