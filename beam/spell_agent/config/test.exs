import Config

# Khepri/Ra emit verbose :debug/:info logs while booting the Ra system and during
# elections. They flood test output and obscure failures. Raise the floor to
# :warning for the durable-history test runs; raise to :error if even that is noisy.
config :logger, level: :warning

# A3 (FEAT-021): disable the app-supervised default Mesh.Watcher in tests. The
# whole suite shares the default Memory store, so a default Watcher would observe
# test-written blackboard posts and fire the default Clock -> real SpellAgent.run/2
# (network). Tests that exercise the watcher start their OWN named Watcher with
# `enabled: true` against an injected Clock + fake runner. (Mirrors KhepriBoot's
# config-gated :ignore.)
config :spell_agent, SpellAgent.Mesh.Watcher, enabled: false

# Widen the PtcRunner sandbox wall-clock budget under test (prod default stays
# 1 s). The eval-heavy TUI/cell/reaction tests each spawn a `PtcRunner.Sandbox`
# child (1 s cap); under full-suite async parallelism those children fight for
# schedulers and a trivially-fast, deterministic program can be starved past the
# cap and surface as a flaky `{:error, reason: :timeout}` (the same load-sensitive
# class as FUP-026 in the ptc_runner suite). No test relies on the 1 s default for
# correctness: timeout-behaviour tests pass an explicit small `timeout:`.
config :ptc_runner, default_timeout: 30_000
