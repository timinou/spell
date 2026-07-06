defmodule SpellAgent.Tui.KeymapIntrospect do
  @moduledoc """
  Reflect the LIVE keymap into flat, renderable rows (FEAT-047).

  Every discoverability surface — the which-key hint bar, the help overlay, the
  command palette — is a projection of the SAME question: "what chords are bound
  to what, right now?". The keymap already holds that answer as data:

    * each context module exposes a compiled `keymap/0` (`[{%Chord{}, intent}]`)
      and a `context_name/0` registry key;
    * `KeymapRegistry.bindings(ctx)` holds the LIVE runtime overrides.

  This module is the ONE place that unions them into `%{"context" "chord"
  "intent" "label" "dispatch-ctx"}` rows — so no surface hand-lists bindings (the
  "reflect, don't hand-list" rule). A live `keymap/bind` override WINS over the
  compiled entry for the same `{context, chord}`, exactly as `Keys.resolve/3`
  resolves a real keystroke — so what the help/hint/palette SHOWS is what the key
  DOES.

  ## Rows

  Each row is string-keyed (PTC/DataBag-ready):

    * `"context"`      — the registry key as a string (`"global"`, `"tree"`, …),
      for grouping + display.
    * `"chord"`        — the human chord (`"C-o"`, `"tab"`), via `Chord.to_string/1`.
    * `"intent"`       — the intent as a string (`"app/cockpit"`).
    * `"label"`        — a human label derived from the intent (`"cockpit"`),
      with a small curated override for the ones whose bare segment reads poorly.
    * `"dispatch-ctx"` — the TRUSTED context term for dispatch (the module for a
      compiled context, the bare atom for a runtime one). NEVER re-interned from
      a display string — carried straight from the source so the palette can fire
      a row without `String.to_atom` on untrusted data (oracle gate, agent 30).

  ## Never-brick

  Total: a down `KeymapRegistry` degrades to compiled-only (try/rescue/catch, the
  same posture as `HintBar.live_bindings/1`); a context that fails to reflect is
  skipped, not fatal; the whole thing is bounded by `@max_rows` so a runaway
  registry can never unbound the render surface.
  """

  alias SpellAgent.Tui.{Chord, KeymapRegistry, Keys, PaneContext}
  alias SpellAgent.Tui.Keymap.Global

  @typedoc "A flat, string-keyed binding row."
  @type row :: %{optional(String.t()) => term()}

  # The compiled contexts whose bindings are reflected, in display order
  # (global last so pane-specific chords read first — matches the resolver's
  # most-specific-first cascade). Each is a module exporting `context_name/0` +
  # `keymap/0`. A runtime-declared pane context (a bare atom, no compiled module)
  # is folded in via its LIVE registry bindings below.
  # `Global` is not a per-focus context (it is the fallback layer every stack
  # resolves through, never itself registered in PaneContext); the per-pane
  # contexts are REFLECTED from `PaneContext.all/0` (see `compiled_contexts/0`
  # below) instead of hand-listed here — the audit's Svadhisthana finding: a
  # hand-maintained module list beside a live registry meant a runtime-declared
  # pane context could be active for real keystrokes yet invisible to help/
  # palette/hints. Reflecting `PaneContext.all/0` closes that gap; a context
  # registered at ANY time (boot or runtime) is discoverable.
  @global_context Global

  # The NATIVE FLOOR (never-brick fallback only — NOT the primary source): if
  # `PaneContext` is down or not yet seeded (a headless test, or a render before
  # `App.mount/1`'s `PaneContext.register_all/1` has run), reflection still needs
  # SOMETHING. Mirrors `App.@native_pane_contexts` exactly. Once the registry is
  # up, `compiled_contexts/0` below reflects it and this floor is a UNION
  # fallback, not a ceiling — a runtime-registered context is never masked by it.
  @native_floor [SpellAgent.Tui.Panes.SpanTree, SpellAgent.Tui.Panes.History, SpellAgent.Tui.Panes.Detail, SpellAgent.Tui.Keymap.TurnNav, SpellAgent.Tui.Keymap.Prompt]

  # Hard cap on reflected rows — defense in depth so the help/palette surface is
  # bounded regardless of how many live bindings a client registered. Generous:
  # the whole keymap is a few dozen chords.
  @max_rows 128

  # Curated intent -> label overrides for intents whose bare last segment reads
  # poorly on its own. Anything not here derives from the intent's last path
  # segment (`nav/next` -> "next"). Kept tiny on purpose.
  @label_overrides %{
    "focus/next" => "next pane",
    "focus/prev" => "prev pane",
    "app/reset-layout" => "reset layout",
    "app/toggle-cells" => "cells",
    "app/cockpit" => "cockpit",
    "app/palette" => "commands",
    "app/help" => "help",
    "frame/leader" => "frame leader",
    "mode/insert" => "insert",
    "nav/child" => "in",
    "nav/parent" => "out",
    "cursor/page-prev" => "page up",
    "cursor/page-next" => "page down"
  }

  @doc """
  All binding rows across every known context (compiled ⊕ live), newest-context
  first, bounded to `@max_rows`. Total.
  """
  @spec rows() :: [row()]
  def rows do
    runtime = runtime_context_names()

    (compiled_contexts() ++ runtime)
    |> Enum.flat_map(&context_rows/1)
    |> dedup_by_context_chord()
    |> Enum.take(@max_rows)
  end

  @doc """
  Rows for a single context (`:global`, `:tree`, a module, or a runtime atom).
  Live registry bindings WIN over compiled entries for the same chord.
  """
  @spec context_rows(module() | atom()) :: [row()]
  def context_rows(ctx) do
    name = Keys.context_name(ctx)

    compiled = compiled_pairs(ctx)
    # Cap live bindings PER CONTEXT before any sort/map/reject work runs — the
    # audit's Third Eye finding: `Enum.take(@max_rows)` in rows/0 bounded only
    # the OUTPUT, so an uncapped `keymap/bind` could still force a full sort +
    # dedup over thousands of live bindings before the cap ever applied. No
    # single context can contribute more rows than the global cap allows anyway,
    # so capping the WORK here is free — it changes no observable output for a
    # well-behaved registry, only the cost of a hostile one.
    live = name |> live_pairs() |> Enum.take(@max_rows)
    live_by_chord = Map.new(live, fn {chord, intent} -> {Chord.to_string(chord), intent} end)

    # Compiled chords first, IN DECLARATION ORDER (so an intent's PRIMARY chord
    # leads — `j` before `down` for nav/next). A live rebind of a compiled chord
    # replaces its intent IN PLACE (the chord keeps its declared position).
    compiled_rows =
      Enum.map(compiled, fn {chord, intent} ->
        chord_s = Chord.to_string(chord)

        # C-r under :global is HARDCODED in App.handle_event/2 as the emergency
        # reset — it short-circuits BEFORE the resolver runs, so no live
        # `keymap/bind` can ever actually change what the real key does (the
        # audit's Manipura finding: "the map disagrees with the territory for
        # exactly one chord"). Pin this ONE row to its true, unoverridable
        # intent rather than let a live rebind make the reflection lie.
        effective_intent =
          if name == :global and chord_s == "C-r" do
            intent
          else
            Map.get(live_by_chord, chord_s, intent)
          end

        row(name, ctx, chord_s, effective_intent)
      end)

    # Then any LIVE-ONLY chord (bound to a chord the compiled keymap does not
    # declare), sorted for a stable append order.
    compiled_chords = MapSet.new(compiled, fn {chord, _} -> Chord.to_string(chord) end)

    live_only_rows =
      live
      |> Enum.reject(fn {chord, _} -> MapSet.member?(compiled_chords, Chord.to_string(chord)) end)
      |> Enum.sort_by(fn {chord, _} -> Chord.to_string(chord) end)
      |> Enum.map(fn {chord, intent} -> row(name, ctx, Chord.to_string(chord), intent) end)

    compiled_rows ++ live_only_rows
  rescue
    _ -> []
  catch
    _, _ -> []
  end

  @doc "The human label for an intent string (curated override, else derived)."
  @spec label_for(String.t()) :: String.t()
  def label_for(intent) when is_binary(intent) do
    case Map.get(@label_overrides, intent) do
      nil -> intent |> String.split("/") |> List.last() |> humanize()
      label -> label
    end
  end

  def label_for(_), do: ""

  @doc """
  The per-pane context modules reflected right now: `Global` (the always-present
  fallback layer) plus every module `PaneContext.all/0` reports — UNIONED with
  the native floor so a headless caller (before `App.mount/1` has seeded the
  registry) still sees the built-in panes. A context registered at runtime via
  `PaneContext.register/2` appears here with NO edit to this module.
  """
  @spec compiled_contexts() :: [module()]
  def compiled_contexts do
    registered = PaneContext.all() |> Map.values() |> Enum.uniq()
    [@global_context | Enum.uniq(registered ++ @native_floor)]
  rescue
    _ -> [@global_context | @native_floor]
  catch
    :exit, _ -> [@global_context | @native_floor]
  end

  @doc "The row cap."
  @spec max_rows() :: pos_integer()
  def max_rows, do: @max_rows

  # ---- internals ----

  defp row(name, ctx, chord_str, intent) do
    intent_str = to_string(intent)

    %{
      "context" => to_string(name),
      "chord" => chord_str,
      "intent" => intent_str,
      "label" => label_for(intent_str),
      # The TRUSTED dispatch context term (module for compiled, bare atom for
      # runtime). Carried straight from the source — never re-interned from the
      # display string. Stored as-is (a module or atom); the palette hands it back
      # to Keys.dispatch, which guards Code.ensure_loaded?.
      "dispatch-ctx" => ctx
    }
  end

  # Compiled `keymap/0` pairs for a context, or [] for a runtime atom / a module
  # without a compiled keymap (guarded exactly like Keys.compiled_intent/2).
  defp compiled_pairs(ctx) when is_atom(ctx) do
    if Code.ensure_loaded?(ctx) and function_exported?(ctx, :keymap, 0) do
      ctx.keymap()
    else
      []
    end
  end

  # Live registry bindings for a context name, or [] if the registry is down —
  # the same best-effort posture HintBar.live_bindings/1 uses (the registry may
  # not be running under a headless render test).
  defp live_pairs(name) do
    KeymapRegistry.bindings(name)
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  # Runtime-declared context names that have LIVE bindings but no compiled module
  # in `compiled_contexts/0` (a keymap/bind to a fresh context atom with no
  # PaneContext registration at all). Reflected so a runtime binding is as
  # discoverable as a compiled one. Best-effort: a down registry yields no extra
  # contexts.
  defp runtime_context_names do
    compiled_names = MapSet.new(compiled_contexts(), &Keys.context_name/1)

    all_binding_context_names()
    |> Enum.reject(&MapSet.member?(compiled_names, &1))
    |> Enum.uniq()
  end

  defp all_binding_context_names do
    KeymapRegistry.binding_contexts()
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  # Final dedup across contexts by {context, chord} — a defensive guard; contexts
  # are already disjoint by name, but a runtime atom colliding with a compiled
  # name must not double-list. First wins (compiled contexts come first).
  defp dedup_by_context_chord(rows) do
    rows
    |> Enum.reduce({[], MapSet.new()}, fn r, {acc, seen} ->
      key = {r["context"], r["chord"]}

      if MapSet.member?(seen, key) do
        {acc, seen}
      else
        {[r | acc], MapSet.put(seen, key)}
      end
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  defp humanize(seg) when is_binary(seg), do: String.replace(seg, "-", " ")
  defp humanize(_), do: ""
end
