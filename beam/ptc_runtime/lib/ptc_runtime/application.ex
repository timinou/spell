defmodule PtcRuntime.Application do
  @moduledoc """
  OTP application entrypoint for the Spell BEAM compute coprocessor.

  Boots the stdio JSON-RPC peer that talks to the parent Spell (Node) session.
  The peer is the only long-lived process; everything else (PTC-Lisp sandbox
  processes) is spawned per `execute` and torn down by `ptc_runner` itself.

  ## stderr hazard (load-bearing)

  A headless BEAM launched by Node with a detached/redirected stderr can crash
  *during boot* with `io:put_chars(standard_error, ...) the device does not
  exist` (observed in a stray `erl_crash.dump`). `PtcRuntime.Logger` installs a
  crash-safe logger backend before anything writes to `:standard_error`, and
  the peer writes protocol frames ONLY to `:stdio`. Never `IO.puts`/`IO.inspect`
  to stderr from the hot path — use `Logger`, which routes to a file when the
  device is absent.
  """
  use Application

  # Captured at compile time — `Mix` is unavailable at runtime inside a release.
  @autostart Mix.env() != :test

  @impl true
  def start(_type, _args) do
    PtcRuntime.Logger.install()

    children = [
      # SPELL PATCH-3 (D-2): owns large parked tool results so they never land
      # on a sandbox heap. A long-lived singleton; per-execute buckets (not the
      # process) are the GC unit. Started before the Peer so it's ready for the
      # first execute.
      PtcRunner.Lisp.HandleStore,
      {PtcRuntime.Peer, peer_opts()}
    ]

    opts = [strategy: :one_for_one, name: PtcRuntime.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # In :test we do not auto-start the stdio peer (it would consume the test
  # runner's stdio). Tests drive Peer with an injected IO transport.
  #
  # Resource caps (PLAN-323) are tunable via env so an operator can tighten the
  # runtime without a rebuild; absent/invalid → the Peer's defaults (concurrent
  # ceiling 8; worker caps fall through to ptc_runner's own defaults).
  defp peer_opts do
    [autostart: @autostart]
    |> put_env_int(:max_heap, "PTC_MAX_HEAP")
    |> put_env_int(:max_concurrent_executes, "PTC_MAX_CONCURRENT_EXECUTES")
    |> put_env_int(:max_parallel_workers, "PTC_MAX_PARALLEL_WORKERS")
    |> put_env_int(:worker_max_heap, "PTC_WORKER_MAX_HEAP")
  end

  defp put_env_int(opts, key, env_name) do
    with value when is_binary(value) <- System.get_env(env_name),
         {n, ""} when n > 0 <- Integer.parse(value) do
      Keyword.put(opts, key, n)
    else
      _ -> opts
    end
  end
end
