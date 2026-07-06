defmodule SpellAgent do
  @moduledoc """
  Node-free coding agent on the BEAM (PLAN-344, v0).

  Public entrypoints:

      SpellAgent.run("What is 2 + 2?")     # one-shot, returns {:ok, result}
      SpellAgent.repl()                     # interactive loop (use from `iex -S mix`)

  Everything runs on the BEAM with ZERO Node: the Claude subscription credential
  is read from `~/.spell/agent/agent.db`, the agentic loop is `PtcRunner.SubAgent`,
  and tools (including ones the agent defines at runtime) resolve through the
  homoiconic registry.
  """

  alias SpellAgent.{Hist, Session}
  alias SpellAgent.Tui.{SessionView, Transcript}

  @doc "Run a single mission. Returns `{:ok, result}` or `{:error, reason}`."
  @spec run(String.t(), keyword()) :: {:ok, term()} | {:error, term()}
  defdelegate run(prompt, opts \\ []), to: Session

  @doc """
  Launch the live inspector TUI (PLAN-345) and BLOCK until you quit it.

  A terminal UI to type a mission and watch everything happening inside the run —
  turns, llm calls, tools, and (when a tool is itself a sub-agent) its nested
  run, arbitrarily deep — plus the final answer in the header.

  The TUI takes over the terminal (alternate screen + raw mode), so it must be
  the SOLE foreground consumer of stdin/stdout. Prefer `mix spell.tui` from a
  real terminal. Calling this from inside an `iex` shell is NOT supported — iex
  keeps reading stdin and printing its prompt, which corrupts the display
  (BUG-489); use the mix task instead.

  Logger output is redirected to `~/.spell/logs/spell-agent.<date>.log` for the
  TUI's lifetime so background debug logs cannot tear the screen; the path is
  printed on exit. See `SpellAgent.Tui.LogRedirect`.

  On exit the whole conversation is also dumped to `~/.spell/traces/<sid>.<ts>.txt`
  — the verbatim transcript (full prompts, tool calls + args, results, replies),
  not a one-line summary — so it survives as a reviewable artifact even though
  the in-memory store dies with the BEAM. Best-effort: a failure never blocks
  teardown.

  ## Durable layouts + keymaps (PLAN-024 Wave 4 / FUP-009)

  Pass `durable: true` to make agent- or user-authored layout shadows and
  keybinding overrides survive across launches (persisted to the SAME durable
  store `Hist` uses — `Hist.Store.Khepri` is already per-project, rooted at
  `File.cwd!()/.spell/forest`, so this is per-project durability for free).
  `fresh: true` skips rehydration for this launch (ignore whatever was
  persisted, start from the native defaults) without discarding the persisted
  record itself — the next non-fresh durable launch still sees it.

      SpellAgent.tui(durable: true)              # remember layout/keymap edits
      SpellAgent.tui(durable: true, fresh: true)  # this launch only: start native

  Returns `:ok` once the app stops (esc / ctrl-c to quit).
  """
  @spec tui(keyword()) :: :ok
  def tui(opts \\ []) do
    # Relocate Logger's console output to a file for the TUI's lifetime: the TUI
    # owns the terminal (raw mode + alternate screen), and any stdout/stderr byte
    # a background Logger.debug/1 emits tears the display. Restored on exit; the
    # path is printed so the logs are reviewable once back at the shell.
    {log_path, snapshot} = SpellAgent.Tui.LogRedirect.start()

    # PLAN-024 Wave 4: flip the ALREADY-RUNNING LayoutRegistry/KeymapRegistry
    # singletons into durable mode for THIS launch, before App.start_link/1 (its
    # `mount` callback has no CLI-flag visibility of its own — see
    # LayoutRegistry.seed_default/1's doc for why ordering matters here).
    maybe_enable_durability(opts)

    try do
      {:ok, pid} =
        SpellAgent.Tui.App.start_link(
          Keyword.merge([name: nil, store: SpellAgent.Tui.Store], Keyword.drop(opts, [:durable, :fresh]))
        )

      ref = Process.monitor(pid)

      receive do
        {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
      end
    after
      SpellAgent.Tui.LogRedirect.stop(snapshot)

      if log_path do
        IO.puts("[spell] logs saved to #{log_path}")
      end

      # Dump every recorded session's full trace to a file, so the whole
      # conversation survives the TUI exit as a reviewable artifact (mirrors the
      # log-path dump above). Best-effort: a failure never blocks teardown.
      dump_traces()
    end
  end

  @doc false
  # Extracted so the exact CLI-flag semantics (`durable:`/`fresh:` -> which
  # registries get enable_durability/1 called, with which rehydrate:) are
  # independently testable without invoking the blocking `tui/1` (which takes
  # over the terminal and blocks on a `:DOWN` receive). `fresh: true` enables
  # durability WITHOUT rehydrating (so a later `set` during this session still
  # persists, but THIS launch starts native) — `durable: false` (the default)
  # is a complete no-op, touching neither registry.
  @spec maybe_enable_durability(keyword()) :: :ok
  def maybe_enable_durability(opts) do
    if Keyword.get(opts, :durable, false) do
      rehydrate? = not Keyword.get(opts, :fresh, false)
      SpellAgent.Tui.LayoutRegistry.enable_durability(rehydrate: rehydrate?)
      SpellAgent.Tui.KeymapRegistry.enable_durability(rehydrate: rehydrate?)
      # PLAN-027 M7 (review Sβ P2): the DataSource registry joins the durable
      # launch — so agent-authored `data-source/register` frozen programs persist
      # across launches, not just layout/keymap. `fresh: true` starts native
      # (rehydrate suppressed) but still persists this session's mutations.
      maybe_enable_data_source_durability(rehydrate?)
    end

    :ok
  end

  # Flip DataSource durability on the live singleton, honoring `--fresh`
  # (rehydrate? false = enable persistence but start native, leaving the
  # persisted blob intact for a later non-fresh launch). Best-effort.
  defp maybe_enable_data_source_durability(rehydrate?) do
    SpellAgent.Tui.DataSource.Registry.enable_durability(rehydrate: rehydrate?)
  end

  # The trace dump writes one file per recorded session to `~/.spell/traces/`
  # (the logs convention). Each file carries the VERBATIM conversation transcript
  # (full prompts, tool calls + args, results, replies) via Transcript.text/2,
  # falling back to the structural turn trace (SessionView.trace_text/2) when a
  # session recorded no continuation tape. Best-effort throughout: a sick store
  # or an unwritable dir degrades to a no-op, never a teardown failure.
  defp dump_traces do
    try do
      store = Hist.default_store()
      dir = Path.expand("~/.spell/traces")
      stamp = Calendar.strftime(DateTime.utc_now(), "%Y%m%d-%H%M%S")
      :ok = File.mkdir_p(dir)

      paths =
        for session <- Hist.sessions(store: store) do
          # Prefer the VERBATIM transcript (full prompts, tool calls+args,
          # results, replies); fall back to the structural turn trace when a
          # session recorded no continuation tape.
          text = Transcript.text(store, session.id) || SessionView.trace_text(store, session.id)
          path = Path.join(dir, "#{session.id}.#{stamp}.txt")
          :ok = File.write!(path, text)
          path
        end

      case paths do
        [] -> :ok
        _ ->
          IO.puts("[spell] traces saved to:")
          IO.puts("  " <> Enum.join(paths, "\n  "))
          :ok
      end
    rescue
      _ -> :ok
    catch
      _, _ -> :ok
    end
  end

  @doc """
  Interactive REPL. Reads a prompt per line, runs it, prints the result. Type
  `exit` (or send EOF) to quit. Intended for `iex -S mix`.
  """
  @spec repl() :: :ok
  def repl do
    IO.puts("spell_agent — node-free BEAM agent. Type a prompt, or 'exit'.\n")
    loop()
  end

  defp loop do
    case IO.gets("» ") do
      :eof ->
        IO.puts("\nbye")
        :ok

      {:error, reason} ->
        IO.puts("input error: #{inspect(reason)}")
        :ok

      line ->
        case String.trim(line) do
          "" ->
            loop()

          cmd when cmd in ["exit", "quit"] ->
            IO.puts("bye")
            :ok

          prompt ->
            print_result(run(prompt))
            loop()
        end
    end
  end

  defp print_result({:ok, result}) when is_binary(result), do: IO.puts(result <> "\n")
  defp print_result({:ok, result}), do: IO.puts(inspect(result, pretty: true) <> "\n")
  defp print_result({:error, reason}), do: IO.puts("error: #{inspect(reason, pretty: true)}\n")
end
