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
