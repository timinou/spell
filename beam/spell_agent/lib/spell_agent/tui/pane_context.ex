defmodule SpellAgent.Tui.PaneContext do
  @moduledoc """
  The focus → keymap-context registry (PLAN-027 M4, FUP-039) — the generic seam
  that lets `App.base_focus_stack/1` resolve a focused pane's keymap context
  WITHOUT enumerating specific panes in Elixir.

  ## Why this exists

  `base_focus_stack/1` used to hardcode the focus-atom → context-module map:

      base_focus_stack(%{ui: %Ui{focus: :tree}})    -> [SpanTree, Global]
      base_focus_stack(%{ui: %Ui{focus: :prompt}})  -> [Prompt, Global]
      base_focus_stack(%{ui: %Ui{focus: :detail}})  -> [TurnNav, Global]
      base_focus_stack(%{ui: %Ui{focus: :history}}) -> [TurnNav, Global]

  Four clauses enumerating the NATIVE panes — the body naming specific features,
  the chakra-misalignment PLAN-027 dissolves. A runtime-declared pane already
  routes generically (its own atom as the context, resolved against the live
  `KeymapRegistry`); this registry brings the NATIVE panes into that same generic
  path. Native panes REGISTER their default context at boot; `base_focus_stack/1`
  becomes ONE clause that reads the registry.

  ## Stored shape

      %{focus_atom => context_module}

  e.g. `%{tree: SpanTree, prompt: Prompt, detail: TurnNav, history: TurnNav}`.
  A focus with a registered context resolves to `[context_module, Global]`; a
  focus with NO registered context (a runtime pane, or an unknown atom) falls
  through to the runtime-pane path (its own atom) or Global-only — the exact
  prior behavior for those, unchanged.

  ## The primitive vs. the policy

  This registry is the PRIMITIVE (the focus→context lookup mechanism). WHICH
  panes register WHICH context is POLICY: today the App seeds the native defaults
  at boot; a future pane (native or agent-declared) registers its own. The body
  no longer hardcodes the map; it reads whatever is registered.

  Session-global `Agent`, same supervision posture as the sibling registries
  (`Keymap`/`Pane`/`Theme`/`Layout`/`Cell`/`DataSource`). In-memory v0; durable
  persistence is the shared registry-durability follow-up (FUP-041).
  """

  use Agent

  @typedoc "A focus atom (`:tree`, `:prompt`, a runtime pane atom) mapped to its keymap-context module."
  @type t :: %{optional(atom()) => module()}

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  @doc """
  Register `focus`'s default keymap-context `module` (the periphery policy call).

  Idempotent by focus atom: re-registering replaces. Best-effort: a no-op if the
  registry is absent (headless), mirroring the sibling registries.
  """
  @spec register(atom(), module()) :: :ok
  def register(focus, module) when is_atom(focus) and is_atom(module) do
    if agent_up?(), do: Agent.update(__MODULE__, &Map.put(&1, focus, module)), else: :ok
  end

  @doc """
  Register several focus→context pairs at once (the boot seed). Best-effort.
  """
  @spec register_all(%{optional(atom()) => module()}) :: :ok
  def register_all(map) when is_map(map) do
    if agent_up?(), do: Agent.update(__MODULE__, &Map.merge(&1, map)), else: :ok
  end

  @doc """
  The keymap-context module registered for `focus`, or `nil` if none.

  `nil` is the signal for `base_focus_stack/1` to fall through to the
  runtime-pane path (the focus's own atom as context) or Global-only — exactly
  the prior behavior for a pane with no compiled context. Best-effort: `nil` when
  the registry is down.
  """
  @spec lookup(atom()) :: module() | nil
  def lookup(focus) when is_atom(focus) do
    if agent_up?(), do: Agent.get(__MODULE__, &Map.get(&1, focus)), else: nil
  end

  def lookup(_), do: nil

  @doc "All registered focus→context pairs (introspection / tests)."
  @spec all() :: t()
  def all do
    if agent_up?(), do: Agent.get(__MODULE__, & &1), else: %{}
  end

  @doc "Wipe all registrations (test reset). Keeps the process."
  @spec reset() :: :ok
  def reset do
    if agent_up?(), do: Agent.update(__MODULE__, fn _ -> %{} end), else: :ok
  end

  defp agent_up?, do: Process.whereis(__MODULE__) != nil
end
