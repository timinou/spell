defmodule SpellAgent.Hist.Store.KhepriBoot do
  @moduledoc """
  Boots the durable Khepri store at app start WHEN Khepri is the configured
  `Hist` store, so the Ra system backing `Hist.Store.Khepri` is live before any
  `:khepri.put` lands on it.

  ## Why this exists

  `Hist.Store.Khepri` writes go to a named Khepri store (`:spell_hist`) that must
  be booted with `Khepri.start/1` — but that call was only ever made in the
  durable-store TEST (`store_khepri_test.exs` setup), never in production. Without
  this child, configuring `store: Khepri` would leave every recording call talking
  to an unstarted store (silently swallowed by `Session.run`'s best-effort
  recording). This child closes that gap: when Khepri is the configured store, it
  boots it once at app start.

  ## Known gap: cross-restart durability is NOT yet delivered

  As wired, `Hist.Store.Khepri.start/1` calls `:khepri.start/2`, whose
  `complete_ra_server_config` mints a fresh random Ra uid on EVERY boot
  (`ra:new_uid/1` appends a `rand:uniform` suffix). A new uid means a new segment
  dir under the data dir, so a fresh BEAM orphan the previous segments and boots
  an empty store — traces do NOT survive a TUI quit + relaunch via Khepri alone.
  (The existing `store_khepri_test` boots once per module and never tested a
  cross-restart round-trip, so this gap went unnoticed.) Fixing it means reusing
  a stable uid / reopening the existing Ra server — a separate task.

  Until then, what Khepri buys over `Store.Memory` is an on-disk WAL for
  with-session crash analysis, NOT cross-restart persistence. The mechanism that
  actually makes a conversation survive a session today is the at-exit trace dump
  in `SpellAgent.tui/1` (writes a file before the BEAM dies).

  ## Best-effort — boot never depends on Khepri

  This child mirrors the documented `Application` posture ("a sick store must
  never change a mission's outcome; boot never depends on Khepri being healthy"):

    * `:ignore` from `init/1` when the configured store is NOT Khepri (the common
      case: tests override to `Store.Memory`, headless runs stay ephemeral).
    * `:ignore` from `init/1` when Khepri IS configured but fails to boot (a Ra
      system error, an unwritable data dir). The supervision tree continues; the
      agent still answers; recording degrades to the best-effort no-op in
      `Session.run`.

  So configuring `store: Khepri` is now an *intent* to be durable, never a boot
  hazard. On shutdown (`terminate/2`) the Ra system is stopped if it was started
  here, so a clean app exit drains Khepri gracefully.

  ## Data dir

  Defaults to Khepri's own default (`.spell/forest` under cwd); override with
  `config :spell_agent, :khepri_dir, "path"`.
  """

  use GenServer

  require Logger

  alias SpellAgent.Hist.Store.Khepri

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    # Only boot when Khepri is actually the configured store. Any other store
    # (Memory in tests, a custom impl) means this child has nothing to do.
    if SpellAgent.Hist.default_store() == Khepri do
      dir = opts[:data_dir] || Application.get_env(:spell_agent, :khepri_dir)
      boot_khepri(dir)
    else
      :ignore
    end
  end

  # Boot Khepri and translate ANY failure — a {:error, _} tuple OR a raised
  # exception (Khepri.start/1 does File.mkdir_p!, which raises on an unwritable
  # dir; the Ra layer can raise too) — into a :ignore, so the supervision tree
  # always continues. This is the load-bearing posture: app start never depends
  # on Khepri being healthy; a bad config or a sick Ra system costs durability,
  # never boot.
  defp boot_khepri(dir) do
    {:ok, _store_id} = Khepri.start(dir)
    {:ok, %{started?: true}}
  rescue
    e ->
      Logger.warning("khepri boot failed (durable history disabled): #{Exception.message(e)}")
      :ignore
  catch
    kind, value ->
      Logger.warning("khepri boot failed (durable history disabled): #{inspect({kind, value})}")
      :ignore
  end

  @impl true
  def terminate(_reason, %{started?: true}) do
    # Drain the Ra system on a clean shutdown so Khepri's WAL flushes; a crash
    # path skips this (Ra recovers its own WAL on next boot). Best-effort.
    Khepri.stop()
  end

  def terminate(_reason, _state), do: :ok
end
