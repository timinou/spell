defmodule PtcRunner.MixProject do
  use Mix.Project

  # ---------------------------------------------------------------------------
  # SPELL VENDORED FORK of ptc_runner 0.11.0 (hex).
  #
  # Spell owns the eval layer of its `execute` compute coprocessor: handle-aware
  # builtins, `psettled`, and preflight lint live here (see SPELL_PATCHES.md for
  # the full divergence ledger and specs/beam-orchestrator/06-execute-substrate.md
  # for the design). Mirrors the crates/brush-core-vendored precedent.
  #
  # This mix.exs is REWRITTEN relative to upstream: dev-only deps (ptc_viewer
  # path dep, credo, dialyxir, ex_doc, benchee, ...) and hex packaging are
  # dropped — as a path dep of ptc_runtime only the runtime surface matters.
  # Optional integrations (req_llm, kino) stay optional and unfetched; the
  # modules referencing them compile but are unused by Spell.
  # ---------------------------------------------------------------------------

  def project do
    [
      app: :ptc_runner,
      version: "0.11.0-spell",
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: ["lib"],
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger]
    ]
  end

  defp deps do
    [
      {:jason, "~> 1.4"},
      {:nimble_parsec, "~> 1.4"},
      {:telemetry, "~> 1.0"},
      # Optional upstream integrations — never fetched by Spell; the referencing
      # modules (llm/req_llm_adapter, kino/trace_tree) degrade at runtime.
      {:req, "~> 0.5", optional: true},
      {:req_llm, "~> 1.8", optional: true},
      {:kino, "~> 0.14", optional: true}
    ]
  end
end
