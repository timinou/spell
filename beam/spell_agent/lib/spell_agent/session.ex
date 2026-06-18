defmodule SpellAgent.Session do
  @moduledoc """
  Ties the pieces into a runnable, node-free agent turn (FEAT-827, PLAN-344):

    credential (agent.db) → Anthropic subscription adapter → PtcRunner.SubAgent
    loop → homoiconic tools (registry + define-*) → answer.

  The agent runs in `ptc_transport: :tool_call` mode: the model writes PTC-Lisp
  programs that call `(tool/…)`, and EVERY tool — the `define-*` meta-tools and
  any tool the agent defines at runtime — resolves through the same registry-
  backed tools map. So a tool authored mid-conversation is immediately callable.
  """

  alias SpellAgent.{Anthropic, Config, Tools}

  @system_prompt """
  You are a node-free coding agent running on the BEAM (Elixir), powered by a
  Claude subscription. You think and act by writing small PTC-Lisp programs that
  call tools as `(tool/name {:arg value})`.

  Your defining capability is HOMOICONICITY: you can author NEW tools at runtime,
  as data. To define a tool, call:

      (tool/define-tool {:name "blast-radius"
                         :params [:sym]
                         :doc "callers of a symbol"
                         :source "(tool/find {:target (str data/sym \\" def->\\")})"})

  A defined tool's :source is itself PTC-Lisp; its params are bound as `data/<param>`
  when the tool is called. After defining it, call it like any built-in:
  `(tool/blast-radius {:sym "verify"})`. Use `(tool/list-tools {})` to see what
  is available, including tools you have defined this session.

  Prefer defining a reusable tool over repeating a computation. Keep answers concise.
  """

  @doc """
  Run a single mission to completion and return `{:ok, result}` or
  `{:error, reason}`. `result` is the agent's `step.return` (its final value).
  """
  @spec run(String.t(), keyword()) :: {:ok, term()} | {:error, term()}
  def run(prompt, opts \\ []) when is_binary(prompt) do
    model = opts[:model] || Config.get("model")
    max_turns = opts[:max_turns] || 12

    agent =
      PtcRunner.SubAgent.new(
        prompt: prompt,
        system_prompt: system_prompt(),
        tools: Tools.build_tools_map(),
        ptc_transport: :tool_call,
        max_turns: max_turns
      )

    case PtcRunner.SubAgent.run(agent, llm: Anthropic.callback(model)) do
      {:ok, step} -> {:ok, step.return}
      {:error, step} -> {:error, step.fail || step.return || :unknown_failure}
    end
  end

  @doc "Assemble the system prompt, appending any live `system-addendum` config."
  @spec system_prompt() :: String.t()
  def system_prompt do
    case Config.get("system-addendum") do
      add when is_binary(add) and add != "" -> @system_prompt <> "\n\n" <> add
      _ -> @system_prompt
    end
  end

end
