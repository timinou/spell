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

  # A CONTEXT is normally a compiled module (a pane's context module, or
  # Global) exporting `keymap/0`. PLAN-024 Wave 1 (FUP-005) lets `focus_stack/1`
  # push a BARE ATOM for a runtime-declared pane (no compiled backing) so its
  # OWN name doubles as its `KeymapRegistry` context key — that atom has no
  # `keymap/0` to call. Guarded exactly like `context_name/1`'s BUG-006 fix
  # (`Code.ensure_loaded?` before `function_exported?`, since the latter is
  # FALSE for a not-yet-loaded module): an uncompiled context simply has no
  # compiled keymap, so only its live `KeymapRegistry` bindings can resolve it.
  defp compiled_intent(ctx, chord) do
    if Code.ensure_loaded?(ctx) and function_exported?(ctx, :keymap, 0) do
      case List.keyfind(ctx.keymap(), chord, 0) do
        {^chord, intent} -> intent
        nil -> nil
      end
    else
      nil
    end
  end

  @doc """
  Dispatch a resolution to the new gaze. A `:unbound` resolution is identity (the
  App routes it elsewhere). A runtime PTC reaction wins over the compiled one.

  `tree` (PLAN-024 Wave 2, FUP-031, optional) is the CURRENT layout tree,
  threaded through to a PTC reaction's tools map (via `Reaction.Ptc.run/5`) so
  an authored reaction can call `lens/*` spatial-focus verbs — the same
  primitive the native `C-w` keybinding uses.

  `mesh_opts` (PLAN-024 Wave 3, FEAT-020, optional) is `%{session_id: region:
  store:}`, threaded through the same way so an authored reaction can call
  `black/*` mesh verbs (e.g. posting a `:resolution` for a hole-affordance
  binding).

  Both default to `nil`, preserving the pre-Wave-2/3 behavior byte-for-byte for
  every caller that doesn't pass them.
  """
  @spec dispatch(resolution(), Ui.t(), map(), (context() -> atom()), map() | nil, map() | nil) ::
          Ui.t()
  def dispatch(
        resolution,
        ui,
        forest,
        context_name \\ &default_context_name/1,
        tree \\ nil,
        mesh_opts \\ nil
      )

  def dispatch(:unbound, %Ui{} = ui, _forest, _name, _tree, _mesh_opts), do: ui

  def dispatch({:intent, intent, ctx}, %Ui{} = ui, forest, context_name, tree, mesh_opts) do
    name = context_name.(ctx)

    case KeymapRegistry.lookup_reaction(name, intent) do
      nil ->
        # Compiled reaction: the context's own react/3 clause. A
        # PLAN-024-Wave-1 runtime pane context (a bare atom, no compiled
        # module) can only ever reach `:intent` via a LIVE KeymapRegistry
        # binding (compiled_intent/2 returns nil for it), so its behaviour must
        # come from a LIVE reaction too — there is no compiled react/3 to fall
        # back to. Guarded identically to compiled_intent/2 (BUG-006 posture):
        # identity (no-op) rather than an UndefinedFunctionError.
        compiled_react(ctx, intent, ui, forest)

      source when is_binary(source) ->
        run_ptc_reaction(source, ui, forest, tree, mesh_opts)
    end
  end

  defp compiled_react(ctx, intent, ui, forest) do
    if Code.ensure_loaded?(ctx) and function_exported?(ctx, :react, 3) do
      ctx.react(intent, ui, forest)
    else
      ui
    end
  end

  # The PTC reaction runner lands in W3 (SpellAgent.Tui.Reaction.Ptc). Until then,
  # a stored reaction is a no-op so the seam compiles and the compiled path is
  # fully exercised. Resolved at runtime (Code.ensure_loaded?) so W1 needs no stub
  # module and W3 needs no edit here. `tree` (PLAN-024 Wave 2) and `mesh_opts`
  # (PLAN-024 Wave 3) ride along as the 4th/5th args, present in
  # Reaction.Ptc.run/5 since Wave 3 landed; still guarded via
  # function_exported?/3 so a not-yet-loaded module degrades to identity exactly
  # as before.
  defp run_ptc_reaction(source, ui, forest, tree, mesh_opts) do
    mod = SpellAgent.Tui.Reaction.Ptc

    if Code.ensure_loaded?(mod) and function_exported?(mod, :run, 5) do
      # apply/3 (not mod.run/5) keeps this a RUNTIME dispatch: W1 compiles with no
      # reference to the W3 module, so no "undefined function" warning before it
      # exists, and later waves need no edit here — the seam resolves itself once
      # the module is loaded.
      apply(mod, :run, [source, ui, forest, tree, mesh_opts])
    else
      ui
    end
  end

  @doc """
  Dispatch a resolution to its reaction, returning a TAGGED result
  (`{:gaze, ui}` | `{:effect, name, args}`) — the M5 effect-aware path
  (PLAN-027 M5, FUP-040).

  Identical to `dispatch/6` except the return: a live PTC reaction may evaluate to
  a data-encoded App EFFECT (via `Reaction.Ptc.run_effectful/5`), which the App
  interprets through the bounded `EffectRegistry`. A compiled `react/3` reaction
  can only ever produce a gaze, so it is wrapped `{:gaze, ui}`. `:unbound` and an
  uncompiled context both yield `{:gaze, ui}` (the unchanged gaze). This is the
  ACT-half sibling of `dispatch/6`'s LOOK-only contract.
  """
  @spec dispatch_effectful(term(), Ui.t(), map(), (term() -> atom()), map() | nil, map() | nil) ::
          {:gaze, Ui.t()} | {:effect, String.t(), map()}
  def dispatch_effectful(
        resolution,
        ui,
        forest,
        context_name \\ &default_context_name/1,
        tree \\ nil,
        mesh_opts \\ nil
      )

  def dispatch_effectful(:unbound, %Ui{} = ui, _forest, _name, _tree, _mesh_opts), do: {:gaze, ui}

  def dispatch_effectful({:intent, intent, ctx}, %Ui{} = ui, forest, context_name, tree, mesh_opts) do
    name = context_name.(ctx)

    case KeymapRegistry.lookup_reaction(name, intent) do
      nil ->
        # A compiled react/3 can only produce a gaze — wrap it.
        {:gaze, compiled_react(ctx, intent, ui, forest)}

      source when is_binary(source) ->
        run_ptc_reaction_effectful(source, ui, forest, tree, mesh_opts)
    end
  end

  defp run_ptc_reaction_effectful(source, ui, forest, tree, mesh_opts) do
    mod = SpellAgent.Tui.Reaction.Ptc

    if Code.ensure_loaded?(mod) and function_exported?(mod, :run_effectful, 5) do
      apply(mod, :run_effectful, [source, ui, forest, tree, mesh_opts])
    else
      {:gaze, ui}
    end
  end

  # Default: a context module exposes its registry key via `context_name/0`
  # (panes will; Global answers :global). Falls back to the module itself.
  defp default_context_name(ctx), do: context_name(ctx)

  @doc """
  The registry key for a context module — its `context_name/0` if it exports one,
  else the module itself.

  MUST guard with `Code.ensure_loaded?/1` before `function_exported?/3`:
  `function_exported?` returns FALSE for a module the BEAM has not LAZILY LOADED
  yet (BUG-006). Without the guard, a not-yet-loaded pane context resolves to the
  module instead of its `:atom` key, silently dropping registry lookups and hint
  chords. Public so the App's hint path shares the one correct implementation.
  """
  @spec context_name(module()) :: atom() | module()
  def context_name(ctx) when is_atom(ctx) do
    if Code.ensure_loaded?(ctx) and function_exported?(ctx, :context_name, 0) do
      ctx.context_name()
    else
      ctx
    end
  end
end
