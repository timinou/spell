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
      {PtcRuntime.Peer, peer_opts()}
    ]

    opts = [strategy: :one_for_one, name: PtcRuntime.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # In :test we do not auto-start the stdio peer (it would consume the test
  # runner's stdio). Tests drive Peer with an injected IO transport.
  defp peer_opts do
    [autostart: @autostart]
  end
end
