import Config

# Force ex_ratatui to build its Rust NIF FROM SOURCE rather than downloading the
# upstream precompiled artifact (PLAN-346 D5/W0). We vendor ex_ratatui as a
# submodule (`beam/ex_ratatui-vendored`, a path dep) specifically to patch the
# NIF for the kitty keyboard protocol — see that dir's SPELL_PATCHES.md. Without
# this, rustler_precompiled would fetch the unpatched precompiled .so for the
# pinned version and our terminal.rs patch would never run.
#
# We use `force_build_all` rather than the per-app `force_build: [ex_ratatui: ...]`
# key because ExRatatui.Native hardcodes `force_build:` into its precompiled opts
# from the EX_RATATUI_BUILD env var BEFORE the per-app config is consulted via
# `Keyword.put_new/3` — so the per-app key is silently shadowed (a no-op). The
# `force_build_all` path IS read through `Application.compile_env/3`, so it takes
# effect. ex_ratatui is the only `rustler_precompiled` NIF in this project
# (exqlite builds via elixir_make), so this only forces the ex_ratatui source
# build — no other NIF is affected.
config :rustler_precompiled, force_build_all: true

# Conversation-history store. Defaults to the ephemeral `Store.Memory` (an ETS
# table that survives across `Session.run` calls within one BEAM sitting) so app
# boot never depends on a Ra system. Opt into `Store.Khepri` for an on-disk WAL
# (in-session persistence to `.spell/forest`; `Hist.Store.KhepriBoot` boots it
# best-effort). NOTE: cross-BEAM-restart durability is a KNOWN GAP — each fresh
# `:khepri.start` mints a new Ra uid and orphans prior segments — so Khepri does
# not yet persist traces across TUI sittings on its own. The at-exit trace dump
# (see `SpellAgent.tui/1`) is what makes a conversation survive a session today.
#
# config :spell_agent, SpellAgent.Hist, store: SpellAgent.Hist.Store.Khepri

# Load environment-specific config (test.exs quiets Khepri/Ra boot logs).
if File.exists?(Path.join(__DIR__, "#{config_env()}.exs")) do
  import_config "#{config_env()}.exs"
end
