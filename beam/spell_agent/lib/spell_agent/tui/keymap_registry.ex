defmodule SpellAgent.Tui.KeymapRegistry do
  @moduledoc """
  Live, runtime-mutable keybinding overrides (PLAN-346) — the homoiconic surface
  of the Reaction DSL, mirroring `SpellAgent.ToolRegistry`.

  Two override tables, both keyed by a context atom (a pane name like `:tree`, or
  `:global`):

    * BINDINGS — `{context, %Chord{}} => intent`. A live rebind that SHADOWS the
      pane's compiled `keymap/0`. `keymap/bind` writes here; the resolver
      (`SpellAgent.Tui.Keys`) reads here FIRST, then the compiled keymap.
    * REACTIONS — `{context, intent} => ptc_source`. A reaction authored at
      runtime as PTC-Lisp SOURCE TEXT (code-as-data). `keymap/define-reaction`
      writes here; the dispatcher runs the source when the intent fires, instead
      of the pane's compiled `react/3` clause.

  This is the exact two-axis modifiability PLAN-346 is built around: BINDINGS
  rebind keys; REACTIONS redefine behaviour; neither touches the other, and both
  are pure data you can read back (`bindings/1`, `reactions/1`) and diff.

  v0 storage is in-memory (Agent-backed), session-scoped — same posture as
  ToolRegistry. Durable persistence is a follow-up.
  """

  use Agent

  alias SpellAgent.Tui.Chord

  @type context :: atom()
  @type intent :: atom()
  @type state :: %{bindings: %{{context(), Chord.t()} => intent()}, reactions: %{{context(), intent()} => String.t()}}

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{bindings: %{}, reactions: %{}} end, name: __MODULE__)
  end

  # ---- bindings (chord -> intent) ----

  @doc "Bind a chord to an intent in a context (shadows the compiled keymap)."
  @spec bind(context(), Chord.t(), intent()) :: :ok
  def bind(context, %Chord{} = chord, intent) when is_atom(context) and is_atom(intent) do
    Agent.update(__MODULE__, fn s -> put_in(s.bindings[{context, chord}], intent) end)
  end

  @doc "Remove a live binding for a chord in a context (reveals the compiled one)."
  @spec unbind(context(), Chord.t()) :: :ok
  def unbind(context, %Chord{} = chord) when is_atom(context) do
    Agent.update(__MODULE__, fn s -> update_in(s.bindings, &Map.delete(&1, {context, chord})) end)
  end

  @doc "The live intent override for a chord in a context, or nil."
  @spec lookup_binding(context(), Chord.t()) :: intent() | nil
  def lookup_binding(context, %Chord{} = chord) do
    Agent.get(__MODULE__, fn s -> Map.get(s.bindings, {context, chord}) end)
  end

  @doc "All live bindings for a context, as `[{Chord.t(), intent}]`."
  @spec bindings(context()) :: [{Chord.t(), intent()}]
  def bindings(context) do
    Agent.get(__MODULE__, fn s ->
      for {{ctx, chord}, intent} <- s.bindings, ctx == context, do: {chord, intent}
    end)
  end

  # ---- reactions (intent -> ptc source) ----

  @doc "Store a runtime-authored reaction (PTC source) for an intent in a context."
  @spec put_reaction(context(), intent(), String.t()) :: :ok
  def put_reaction(context, intent, source) when is_atom(context) and is_atom(intent) and is_binary(source) do
    Agent.update(__MODULE__, fn s -> put_in(s.reactions[{context, intent}], source) end)
  end

  @doc "The PTC source override for an intent in a context, or nil."
  @spec lookup_reaction(context(), intent()) :: String.t() | nil
  def lookup_reaction(context, intent) when is_atom(context) and is_atom(intent) do
    Agent.get(__MODULE__, fn s -> Map.get(s.reactions, {context, intent}) end)
  end

  @doc "All runtime reactions for a context, as `[{intent, source}]`."
  @spec reactions(context()) :: [{intent(), String.t()}]
  def reactions(context) do
    Agent.get(__MODULE__, fn s ->
      for {{ctx, intent}, source} <- s.reactions, ctx == context, do: {intent, source}
    end)
  end

  @doc "Wipe all overrides (e.g. between tests / sessions). Keeps the process."
  @spec reset() :: :ok
  def reset, do: Agent.update(__MODULE__, fn _ -> %{bindings: %{}, reactions: %{}} end)
end
