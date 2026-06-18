defmodule SpellAgent.Application do
  @moduledoc """
  OTP application + supervision tree for the node-free BEAM agent (PLAN-344).

  Starts, in order:
    * `SpellAgent.ToolRegistry` — the homoiconic tool registry (FEAT-826).
    * `SpellAgent.OAuth`        — subscription credential holder + refresher (FEAT-825).

  Both are long-lived, session-global GenServers. The agent loop itself is
  invoked per-prompt via `SpellAgent.run/1` (FEAT-827) and is not supervised
  here — a crashed run must not take down the registry or the auth state.
  """

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      SpellAgent.Config,
      SpellAgent.ToolRegistry,
      SpellAgent.OAuth,
      # The inspector TUI's live span forest (PLAN-345). Long-lived + session-
      # global, attached to telemetry on first use; the App (which grabs the
      # terminal) is launched on demand via `SpellAgent.tui/0`.
      SpellAgent.Tui.Store
    ]

    opts = [strategy: :one_for_one, name: SpellAgent.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
