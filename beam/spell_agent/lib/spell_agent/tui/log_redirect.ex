defmodule SpellAgent.Tui.LogRedirect do
  @moduledoc """
  Relocates Elixir Logger's console output to a file for the lifetime of a TUI
  session, so background logs can never corrupt the raw-mode screen.

  ## Why

  The TUI owns the terminal (alternate screen + raw mode via ex_ratatui). Any
  byte the OTP Logger writes to stdout/stderr — a `Logger.debug/1` from
  `PtcRunner.SubAgent.TypeExtractor` ("union types not yet supported") is the
  common offender — lands mid-frame and tears the display. The Logger's default
  handler (`:logger_std_h`) writes to `:standard_io`, so for the duration of the
  TUI we swap it to a daily log file under `~/.spell/logs/`.

  ## Scope

  This is device relocation only — level, formatter, and filters are carried over
  verbatim, so the messages land in the file with the same shape they'd have had
  on the console. `stop/1` restores the original handler when the TUI exits.

  ## Notes on the OTP API

  `:logger_std_h` treats `type`/`file`/`modes` as write-once, so a device change
  via `update_handler_config/3` is rejected as `:illegal_config_change` — the swap
  must be a `remove_handler` + `add_handler` pair. The file path must be an Erlang
  charlist (`is_list/1`); a binary path is silently rejected as `:invalid_config`.
  """

  @doc """
  The daily log file the TUI redirects console output to.

  Matches the `~/.spell/logs/` convention used by the TypeScript packages, with a
  `spell-agent.` prefix so BEAM logs are distinguishable. One file per UTC day,
  appended to across sessions.
  """
  @spec log_file() :: String.t()
  def log_file do
    date = Date.utc_today() |> Date.to_iso8601(:basic)
    Path.expand("~/.spell/logs/spell-agent.#{date}.log")
  end

  @doc """
  Redirect the default Logger handler to `log_file/0`.

  Returns `{path, snapshot}` — pass `snapshot` to `stop/1` to restore console
  output. Best-effort: if the default handler is absent, is not `:logger_std_h`,
  or the file device cannot be installed, returns `{nil, nil}` and the TUI
  proceeds with the logger as-is (no worse than before). The handler is never left
  in a half-swapped state — a failed install re-adds the original handler.
  """
  @spec start() :: {String.t() | nil, term()}
  def start do
    path = log_file()

    with :ok <- ensure_dir(path),
         {:ok, %{module: :logger_std_h} = cfg} <- :logger.get_handler_config(:default),
         :ok <- swap(cfg, file_config(path)) do
      {path, cfg}
    else
      _ -> {nil, nil}
    end
  end

  @doc """
  Restore the default handler to its pre-`start/0` device.

  Idempotent and safe to call with `nil` (a no-op `start/0`). Never raises — a
  failed restore is swallowed so TUI teardown can always complete.
  """
  @spec stop(term()) :: :ok
  def stop(nil), do: :ok

  def stop(%{} = cfg) do
    try do
      _ = swap(cfg, cfg[:config] || %{})
    catch
      _, _ -> :ok
    end

    :ok
  end

  # --- internals ---

  defp ensure_dir(path) do
    File.mkdir_p(Path.dirname(path))
    :ok
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  # The `:config` sub-map for a `:logger_std_h` file device. The path MUST be a
  # charlist — the handler's validator checks `is_list(File)` and rejects a binary
  # path as `:invalid_config`. `filesync_repeat_interval: 1000` makes the file
  # tail-able from another pane while the TUI runs (the handler also flushes on
  # removal, so `stop/1` is the guaranteed drain point).
  defp file_config(path) do
    %{
      type: {:file, String.to_charlist(path)},
      filesync_repeat_interval: 1_000
    }
  end

  # Atomically-ish swap the default handler's device: remove + re-add. If the
  # re-add fails, the ORIGINAL handler is re-installed so logging is never lost.
  # `:logger_std_h` rejects `update_handler_config` for type/file (write-once),
  # so this remove+add pair is the only way to change the device.
  defp swap(cfg, config) do
    shape = handler_shape(cfg, config)
    :logger.remove_handler(:default)

    case :logger.add_handler(:default, :logger_std_h, shape) do
      :ok ->
        :ok

      {:error, _} ->
        # Install failed — restore the original device so the handler survives.
        :logger.add_handler(:default, :logger_std_h, handler_shape(cfg, cfg[:config] || %{}))
        :error
    end
  end

  defp handler_shape(cfg, config) do
    %{
      level: cfg[:level],
      formatter: cfg[:formatter],
      filters: cfg[:filters],
      filter_default: cfg[:filter_default],
      config: config
    }
  end
end
