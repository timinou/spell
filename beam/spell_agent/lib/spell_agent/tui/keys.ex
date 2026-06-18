defmodule SpellAgent.Tui.Keys do
  @moduledoc """
  The resolver (PLAN-346) — the pure fold that turns a keystroke into a new gaze.

  It is the engine behind the Reaction DSL's two-stage indirection:

      chord ──[resolve/3]──▶ {intent, context} ──[dispatch/4]──▶ %Ui{}'
            (keymap cascade)                     (reaction cascade)

  ## resolve/3 — chord → intent (the keymap cascade)

  Given the chord and a CONTEXT STACK (`[focused_pane_module, Keymap.Global]`,
  most-specific first), find the first context that binds the chord. Within each
  context, the LIVE registry override (`KeymapRegistry`) wins over the compiled
  `keymap/0` — so a runtime `keymap/bind` shadows the source. Returns
  `{:intent, intent, context}` or `:unbound` (the App then treats the chord as
  composer text, the lowest-priority sink).

  This is the Emacs major/minor/global cascade, but every layer is data: the
  SAME chord resolves to a DIFFERENT intent under a different focus (e.g. `C-l`
  → `:\"span/expand\"` in the tree, `:\"turn/next\"` in the answer pane), with no
  `if focus == …` anywhere — the stack ordering does it.

  ## dispatch/4 — intent → gaze' (the reaction cascade)

  Given a resolved `{:intent, intent, context}`, produce the next gaze. A runtime
  PTC reaction (`KeymapRegistry.lookup_reaction`) wins over the context's compiled
  `react/3`; the PTC path is wired in W3 via `SpellAgent.Tui.Reaction.Ptc`. Both
  axes (rebind a key / redefine a behaviour) are independent and live.
  """

  alias SpellAgent.Tui.{Chord, KeymapRegistry, Ui}

  @typedoc "A resolution context: a pane module or the global keymap module."
  @type context :: module()

  @typedoc "What a chord resolved to."
  @type resolution :: {:intent, atom(), context()} | :unbound

  @doc """
  Resolve a chord against the context stack (most-specific first). The live
  registry override for `{context_name(ctx), chord}` beats the compiled keymap.
  """
  @spec resolve(Chord.t(), [context()], (context() -> atom())) :: resolution()
  def resolve(%Chord{} = chord, stack, context_name \\ &default_context_name/1) do
    Enum.find_value(stack, :unbound, fn ctx ->
      name = context_name.(ctx)

      case lookup_intent(name, ctx, chord) do
        nil -> nil
        intent -> {:intent, intent, ctx}
      end
    end)
  end

  # Live binding override first, then the context's compiled keymap.
  defp lookup_intent(name, ctx, chord) do
    KeymapRegistry.lookup_binding(name, chord) || compiled_intent(ctx, chord)
  end

  defp compiled_intent(ctx, chord) do
    case List.keyfind(ctx.keymap(), chord, 0) do
      {^chord, intent} -> intent
      nil -> nil
    end
  end

  @doc """
  Dispatch a resolution to the new gaze. A `:unbound` resolution is identity (the
  App routes it elsewhere). A runtime PTC reaction wins over the compiled one.
  """
  @spec dispatch(resolution(), Ui.t(), map(), (context() -> atom())) :: Ui.t()
  def dispatch(resolution, ui, forest, context_name \\ &default_context_name/1)

  def dispatch(:unbound, %Ui{} = ui, _forest, _name), do: ui

  def dispatch({:intent, intent, ctx}, %Ui{} = ui, forest, context_name) do
    name = context_name.(ctx)

    case KeymapRegistry.lookup_reaction(name, intent) do
      nil ->
        # Compiled reaction: the context's own react/3 clause.
        ctx.react(intent, ui, forest)

      source when is_binary(source) ->
        run_ptc_reaction(source, ui, forest)
    end
  end

  # The PTC reaction runner lands in W3 (SpellAgent.Tui.Reaction.Ptc). Until then,
  # a stored reaction is a no-op so the seam compiles and the compiled path is
  # fully exercised. Resolved at runtime (Code.ensure_loaded?) so W1 needs no stub
  # module and W3 needs no edit here.
  defp run_ptc_reaction(source, ui, forest) do
    mod = SpellAgent.Tui.Reaction.Ptc

    if Code.ensure_loaded?(mod) and function_exported?(mod, :run, 3) do
      # apply/3 (not mod.run/3) keeps this a RUNTIME dispatch: W1 compiles with no
      # reference to the W3 module, so no "undefined function" warning before it
      # exists, and W3 needs no edit here — the seam resolves itself once the
      # module is loaded.
      apply(mod, :run, [source, ui, forest])
    else
      ui
    end
  end

  # Default: a context module exposes its registry key via `context_name/0`
  # (panes will; Global answers :global). Falls back to the module itself.
  defp default_context_name(ctx) do
    if function_exported?(ctx, :context_name, 0), do: ctx.context_name(), else: ctx
  end
end
