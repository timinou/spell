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
      {:ptc_runner, path: "../ptc_runner"},
      # PLAN-020 W3: the kernel NIF skin over pi-code-engine/pi-code-path. Hosts
      # the tree-sitter -> form_tree projector (parse_code/unparse_code) that
      # `code/parse`/`code/unparse` build on, alongside resolve_target/apply_edit.
      {:pi_kernel_nif, path: "../pi_kernel_nif"},
      # Direct HTTP for the Anthropic subscription adapter (pulls Finch/Mint).
      {:req, "~> 0.5"},
      # Read Spell's agent.db (SQLite) for the subscription credential.
      {:exqlite, "~> 0.27"},
      {:jason, "~> 1.4"},
      # Hist: durable homoiconic conversation-history substrate (PLAN-001).
      # Khepri = tree-like on-disk store (single-node Ra = ordered crash-safe WAL
      # + materialized view).
      {:khepri, "~> 0.18"},
      # The inspector TUI (PLAN-345/346). VENDORED as a git submodule (path dep,
      # same as ptc_runner) so we can patch the Rust NIF — PLAN-346 W0 pushes
      # kitty keyboard-protocol enhancement flags so ctrl+j/h disambiguate from
      # Enter/Backspace. Pinned to upstream tag v0.11.0. Builds from source
      # (rustler), not the precompiled hex package.
      {:ex_ratatui, path: "../ex_ratatui-vendored"},
      # rustler is OPTIONAL in ex_ratatui (it ships a precompiled NIF by default).
      # We force a source build (config/config.exs) to apply our terminal.rs kitty
      # patch, so we must pull rustler explicitly to compile the NIF.
      {:rustler, "~> 0.36", runtime: false},
      # req_llm is intentionally NOT a dep in v0: one provider, direct adapter,
      # full request-body control. Revisit when porting many providers.
      {:stream_data, "~> 1.1", only: [:test]},
      # plug is an OPTIONAL Req dependency; pulling it (test-only) enables
      # `Req.Test` plug stubs for the LLM cassette layer (FEAT-006).
      {:plug, "~> 1.16", only: [:test]}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]
end
