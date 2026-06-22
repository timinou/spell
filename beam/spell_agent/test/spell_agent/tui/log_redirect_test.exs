defmodule SpellAgent.Tui.LogRedirectTest do
  use ExUnit.Case, async: false

  require Logger

  alias SpellAgent.Tui.LogRedirect

  # These tests MUTATE the global OTP `:default` Logger handler, so they MUST be
  # async: false. ExUnit replaces the :default console handler with its own
  # capture mechanism, so there may be nothing to redirect — the setup installs a
  # fresh std_h handler mirroring the production TUI state, then removes it on
  # exit so no handler (especially a file device) leaks into later tests.

  setup do
    remove_default_handler()

    :ok =
      :logger.add_handler(:default, :logger_std_h, %{
        level: :debug,
        formatter: {Logger.Formatter, %{}},
        filters: [],
        filter_default: :log,
        config: %{type: :standard_io}
      })

    on_exit(&remove_default_handler/0)
    :ok
  end

  test "redirects console logs to a file and restores the handler on stop" do
    {:ok, before} = :logger.get_handler_config(:default)
    assert before[:module] == :logger_std_h
    assert before[:config][:type] == :standard_io

    {path, snapshot} = LogRedirect.start()
    assert path != nil, "expected a log path"
    assert snapshot != nil, "expected a handler snapshot"

    try do
      # The handler now writes to a FILE, not stdout.
      {:ok, after_start} = :logger.get_handler_config(:default)
      assert after_start[:config][:type] == :file
      assert after_start[:module] == :logger_std_h

      # A real log event lands in the file, not the console.
      marker = "REDIRECT_MARKER_#{System.unique_integer([:positive])}"
      Logger.warning(marker)

      # stop/1 flushes the file handler on removal — read AFTER stop so the
      # delayed_write buffer is drained (no timing dependency).
      assert LogRedirect.stop(snapshot) == :ok

      assert File.exists?(path)
      assert String.contains?(File.read!(path), marker)
    after
      # Guarantee restore even if an assertion fails mid-way.
      LogRedirect.stop(snapshot)
    end

    # The handler is back to its original device.
    {:ok, restored} = :logger.get_handler_config(:default)
    assert restored[:config][:type] == :standard_io

    File.rm(path)
  end

  test "start/0 is best-effort: stop/1 with nil is a no-op" do
    assert LogRedirect.stop(nil) == :ok
  end

  test "log_file/0 is an absolute daily path under ~/.spell/logs/" do
    path = LogRedirect.log_file()
    assert Path.type(path) == :absolute
    assert String.contains?(path, ".spell/logs/spell-agent.")
    today = Date.utc_today() |> Date.to_iso8601(:basic)
    assert String.ends_with?(path, "#{today}.log")
  end

  defp remove_default_handler do
    try do
      :logger.remove_handler(:default)
    catch
      _, _ -> :ok
    end
  end
end
