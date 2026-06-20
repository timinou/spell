defmodule PtcRuntime.MixProject do
  use Mix.Project

  # ---------------------------------------------------------------------------
  # PtcRuntime — Spell's BEAM compute coprocessor.
  #
  # A thin Elixir application that embeds `ptc_runner` (PTC-Lisp sandbox) and
  # speaks line-delimited JSON-RPC 2.0 over stdio to its parent Spell (Node)
  # session. Spell spawns ONE long-lived runtime per session, hydrates it with
  # a tool + provider catalog at `init`, and issues `execute` requests carrying
  # PTC-Lisp programs. When a program calls `(tool/find {...})` the runtime
  # issues a *reentrant* `tool_call` back to Spell, which services it against
  # the real tool executor and returns the value.
  #
  # This is WS-A / V1 of specs/beam-orchestrator/. The seam built here (spawn +
  # hydrate + bidirectional bridge) is the verbatim WS-B compute lane.
  #
  # Packaging: dev iterates via `mix run`; Phase 0b adds a Burrito release that
  # bundles ERTS into a single binary (no Elixir required on the user machine).
  # The Node-side resolution chain (PTC_RUNTIME_BIN → burrito → mix run) lives
  # in packages/coding-agent/src/tools/ptc-runtime/spawn.ts.
  # ---------------------------------------------------------------------------

  @version "0.1.0"

  def project do
    [
      app: :ptc_runtime,
      version: @version,
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      elixirc_paths: elixirc_paths(Mix.env()),
      releases: releases()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {PtcRuntime.Application, []}
    ]
  end

  defp deps do
    [
      # Spell-owned vendored fork (F0, specs/beam-orchestrator/06-execute-substrate.md):
      # handle-aware builtins, psettled, and preflight lint land in the fork's eval
      # layer. Divergence ledger: beam/ptc_runner/SPELL_PATCHES.md.
      {:ptc_runner, path: "../ptc_runner"},
      # ptc_runner 0.12 added the upstream OpenAPI/MCP-HTTP transports, whose
      # modules reference Req structs (Req is `optional: true` in the fork). We
      # never call those transports, but Elixir compiles every module in the
      # path dep, so Req must be resolvable. Pull it explicitly (spell_agent
      # already does, for its Anthropic adapter).
      {:req, "~> 0.5"},
      {:jason, "~> 1.4"},
      # Property-based testing for the P0' verification lane.
      {:stream_data, "~> 1.1", only: [:test]}
      # NB: Burrito is added in Phase 0b (release packaging), gated behind the
      # release config below so dev `mix run` never requires Zig.
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # Release config. The Burrito wrap step is attached in Phase 0b; until then a
  # plain `mix release` produces a standard ERTS-bundled release directory the
  # Node spawn layer can also target.
  defp releases do
    [
      ptc_runtime: [
        include_executables_for: [:unix],
        applications: [ptc_runtime: :permanent]
      ]
    ]
  end
end
