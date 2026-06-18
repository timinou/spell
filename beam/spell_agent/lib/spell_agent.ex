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
