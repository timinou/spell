defmodule SpellAgent.Application do
  @moduledoc """
  OTP application + supervision tree for the node-free BEAM agent (PLAN-344).

  Starts, in order:
    * `SpellAgent.ToolRegistry`   — the homoiconic tool registry (FEAT-826).
    * `SpellAgent.OAuth`          — subscription credential holder + refresher (FEAT-825).
    * `SpellAgent.SessionRegistry` — live (in-flight) session tracker (PLAN-010).

  Both are long-lived, session-global GenServers. The agent loop itself is
  invoked per-prompt via `SpellAgent.run/1` (FEAT-827) and is not supervised
  here — a crashed run must not take down the registry or the auth state.
  """

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      SpellAgent.Config,
      # The mesh's shared ParallelBudget holder (PLAN-019 M0). Bounds how many
      # spawned child sessions (FEAT-011) + watch-fire workers (FEAT-013) are
      # alive at once. Started right after Config because it reads the
      # "mesh.budget" cell at boot, and BEFORE Mesh.Watcher (which acquires a
      # slot to run a fired :do). Best-effort: a bad config value degrades to the
      # default capacity, and an absent holder degrades spawn to :no_budget —
      # boot never depends on it.
      SpellAgent.Mesh.Budget,
      SpellAgent.OAuth,
      # Live-session tracker (PLAN-010): which conversations are RUNNING right now.
      # The Hist store only knows PAST sessions (recorded on mission exit); this
      # registry is the present half, so a session listing can union open + past.
      # Session-global + long-lived, same posture as ToolRegistry. Best-effort:
      # Session.run wiring tolerates it being absent, so boot never depends on it.
      SpellAgent.SessionRegistry,
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
      # Boots the Khepri Ra system WHEN Khepri is the configured Hist store (see
      # Hist.Store.KhepriBoot for the best-effort posture + the cross-restart
      # durability gap). Started after Memory and BEFORE ToolRegistry so the
      # store is live before durable tools rehydrate from it. Returns :ignore when
      # the store is Memory (the default) or when Khepri fails to boot, so app
      # start never depends on Khepri being healthy.
      SpellAgent.Hist.Store.KhepriBoot,
      # The homoiconic tool registry (FEAT-826, PLAN-011 W3). Started AFTER the
      # Hist store because it REHYDRATES durable (`scope: :durable`) tools from
      # that store on boot — a `:ptc` tool the agent authored in a prior sitting
      # resolves again as if built in. Rehydration is best-effort (sick store ->
      # empty registry), so boot still never depends on the store being healthy.
      SpellAgent.ToolRegistry,
      # The self-wake scheduler (A2, PLAN-014): the first agency organ. Started
      # AFTER the Hist store (like ToolRegistry) because it REHYDRATES persisted
      # wakes (`{:clock, id}`) on boot and re-arms their timers — a wake the agent
      # scheduled in a prior sitting fires again. Rehydration is best-effort (sick
      # store -> empty schedule), so boot never depends on the store being healthy.
      # Session-global + long-lived, same posture as ToolRegistry.
      SpellAgent.Clock,
      # The single-node condition-fuse for black/watch (A3, FEAT-021). Tails the
      # mesh write stream ([:spell, :mesh, :post] telemetry) and, on a post that
      # satisfies a registered :intention predicate, fires an immediate wake
      # THROUGH the Clock above (one detonator, one wake budget) — so it is started
      # AFTER Clock. Best-effort, session-global; boot never depends on it, and a
      # black/watch still persists its durable intention if the watcher is absent.
      SpellAgent.Mesh.Watcher,
      # Live keybinding overrides for the Reaction DSL (PLAN-346): runtime
      # rebinds (keymap/bind) and authored reactions (keymap/define-reaction).
      # Session-global, same posture as ToolRegistry.
      SpellAgent.Tui.KeymapRegistry,
      # Live theme palette for the freeform render mirror (PLAN-009, Edge T):
      # theme/set recolors a named slot; view/ builders read defaults from it.
      # Session-global, same posture as KeymapRegistry.
      SpellAgent.Tui.ThemeRegistry,
      # The canonical layout TREE (PLAN-009): the render mirror as live data. The
      # App seeds the native default at mount; the agent shadows slots; navigation
      # re-tags it. Session-global, same posture as the sibling registries.
      SpellAgent.Tui.LayoutRegistry,
      # Reactive cells (PROJ-004): declared read-only data dependencies the slow
      # clock resolves off-frame and the data bag merges into data/*. Session-
      # global, same posture as the sibling registries.
      SpellAgent.Tui.Cell.Registry,
      # The L−1 self-view render loop guard (PLAN-016 W3): per-mission render
      # accounting (iteration cap + fixpoint detection) so the render→observe→act
      # cycle can't spin. Self-cleaning via pid monitors. Same posture as the
      # sibling registries.
      SpellAgent.Tui.SelfView.Budget
    ]

    opts = [strategy: :one_for_one, name: SpellAgent.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
