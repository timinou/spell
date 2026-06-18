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

  alias SpellAgent.Session

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

  Returns `:ok` once the app stops (esc / ctrl-c to quit).
  """
  @spec tui(keyword()) :: :ok
  def tui(opts \\ []) do
    {:ok, pid} =
      SpellAgent.Tui.App.start_link(Keyword.merge([name: nil, store: SpellAgent.Tui.Store], opts))

    ref = Process.monitor(pid)

    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
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
