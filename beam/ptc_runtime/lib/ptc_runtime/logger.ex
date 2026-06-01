defmodule PtcRuntime.Logger do
  @moduledoc """
  Crash-safe logging setup for a headless, stdio-driven BEAM.

  ## Why this exists

  When Node spawns this runtime it owns the child's stdio. `stdout` carries the
  JSON-RPC protocol; anything else written there corrupts the stream. `stderr`
  may be piped, dropped, or detached depending on how the parent configured the
  spawn — and a BEAM that tries to log to a `:standard_error` device that "does
  not exist" crashes *during boot* (seen in a real `erl_crash.dump`:
  `io:put_chars(standard_error, ...) the device does not exist`).

  `install/0` therefore:

    1. Removes the default `:console` logger backend (which targets stderr).
    2. Routes Elixir `Logger` output to a per-run file under the OS temp dir,
       so diagnostics survive without ever touching the protocol stdio.

  Protocol frames are written by `PtcRuntime.Peer` to `:stdio` (stdout) only.
  Diagnostic/human logging goes through `Logger` → file. The two never mix.
  """

  require Logger

  @doc """
  Install the crash-safe logger configuration. Idempotent.
  """
  @spec install() :: :ok
  def install do
    path = log_path()
    File.mkdir_p!(Path.dirname(path))

    # Add the file handler FIRST so diagnostics have somewhere to go before we
    # detach the default handler.
    file_config = %{
      config: %{file: String.to_charlist(path), modes: [:append]},
      formatter: Logger.Formatter.new(format: "$time [$level] $message\n")
    }

    _ = :logger.add_handler(:ptc_runtime_file, :logger_std_h, file_config)

    # CRITICAL (Review Gate 0, P0): the OTP `:default` `:logger_std_h` handler
    # writes to `:standard_io` — the SAME stdout carrying our JSON-RPC frames.
    # `Logger.remove_backend(:console)` is a deprecated NO-OP on Elixir 1.15+
    # (returns `{:error, :not_found}`), so it never silenced anything. We must
    # remove the OTP handler itself; otherwise Logger output and crash reports
    # interleave with protocol frames and corrupt the NDJSON stream.
    _ = :logger.remove_handler(:default)
    :ok
  rescue
    # Logging setup must never crash the runtime. Worst case: no logs.
    _ -> :ok
  end

  @doc "Resolve the diagnostic log file path for this run."
  @spec log_path() :: String.t()
  def log_path do
    dir = System.get_env("PTC_RUNTIME_LOG_DIR") || System.tmp_dir!()
    Path.join(dir, "ptc_runtime-#{System.os_time(:second)}-#{System.system_time()}.log")
  end
end
