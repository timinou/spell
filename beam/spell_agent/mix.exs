defmodule SpellAgent.MixProject do
  use Mix.Project

  # ---------------------------------------------------------------------------
  # SpellAgent — a node-free coding agent on the BEAM (PLAN-344, v0).
  #
  # Runs with ZERO Node. Authed by a subscription credential (Anthropic Claude
  # Pro/Max OAuth) read directly from Spell's existing ~/.spell/agent/agent.db.
  # Its defining capability is HOMOICONICITY: new tools and config are authored
  # at runtime as PTC-Lisp values (code-as-data), not compiled in.
  #
  # Built in PARALLEL beside the existing TS Spell, which is untouched. Embeds
  # the vendored `ptc_runner` (the agentic loop + PTC-Lisp sandbox) as a path
  # dep, mirroring beam/ptc_runtime/.
  #
  # Layers (see PLAN-344):
  #   SpellAgent.Credentials  — FEAT-824, read agent.db (read-only)
  #   SpellAgent.Anthropic    — FEAT-825, direct Req subscription adapter
  #   SpellAgent.OAuth        — FEAT-825, refresh GenServer
  #   SpellAgent.ToolRegistry — FEAT-826, homoiconic tool registry
  #   SpellAgent.Tools.Define  — FEAT-826, define-tool/define-config host fns
  #   SpellAgent.Session/CLI  — FEAT-827, wire SubAgent + REPL
  # ---------------------------------------------------------------------------

  @version "0.1.0"

  def project do
    [
      app: :spell_agent,
      version: @version,
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :crypto],
      mod: {SpellAgent.Application, []}
    ]
  end

  defp deps do
    [
      # The vendored agentic loop + PTC-Lisp sandbox (path dep, same as ptc_runtime).
      {:ptc_runner, path: "../ptc_runner-vendored"},
      # Direct HTTP for the Anthropic subscription adapter (pulls Finch/Mint).
      {:req, "~> 0.5"},
      # Read Spell's agent.db (SQLite) for the subscription credential.
      {:exqlite, "~> 0.27"},
      {:jason, "~> 1.4"},
      # The inspector TUI (PLAN-345). Precompiled NIF; renders the live span forest.
      {:ex_ratatui, "~> 0.11"},
      # req_llm is intentionally NOT a dep in v0: one provider, direct adapter,
      # full request-body control. Revisit when porting many providers.
      {:stream_data, "~> 1.1", only: [:test]}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]
end
