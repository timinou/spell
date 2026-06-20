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
      SpellAgent.Tui.Store,
      # The conversation-history substrate's default store (PLAN-001/PLAN-003).
      # Store.Memory is a named-singleton ETS GenServer: it makes a conversation
      # survive ACROSS runs within one BEAM sitting (the core TUI win) with zero
      # infra. Cross-restart durability is opt-in via
      # `config :spell_agent, SpellAgent.Hist, store: SpellAgent.Hist.Store.Khepri`
      # (which boots a Ra system); the default stays Memory so app boot never
      # depends on Khepri being healthy.
      SpellAgent.Hist.Store.Memory,
      # Live keybinding overrides for the Reaction DSL (PLAN-346): runtime
      # rebinds (keymap/bind) and authored reactions (keymap/define-reaction).
      # Session-global, same posture as ToolRegistry.
      SpellAgent.Tui.KeymapRegistry
    ]

    opts = [strategy: :one_for_one, name: SpellAgent.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
