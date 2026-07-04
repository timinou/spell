defmodule SpellAgent.Tui.HoleAffordance do
  @moduledoc """
  The hole-affordance generator (PLAN-024 Wave 3 / FEAT-020) — the schema ->
  `{bindings, reactions}` PURE function that closes doc 17's human-surface
  loop: a fillable hole declares a `:slot`; the render walk derives the TUI
  affordances (keymap bindings) and the reactions (keystroke -> `black/post` a
  `:resolution`) FROM that declaration, instead of an author hand-wiring them.

  ## The fillable-hole declaration convention

  A layout node (a pane, a widget leaf) may carry an `"affordance"` tag inside
  its `:tags` map (FEAT-020's spec calls this a node's `:slot`; renamed to
  `tags["affordance"]` here to avoid colliding with the PRE-EXISTING layout-tree
  meaning of `"slot"` — the node's BODY-POSITION name, `Tree.slot/1`/
  `Lens.slot/1`. Same concept FEAT-020 describes, disambiguated placement):

      %{"tags" => %{"affordance" =>
        %{"answer-schema" => %{"choice" => ["proceed" "skip" "defer"]},
          "resolves" => 42,
          "tier" => "human"}}}   ; optional, default "human"

    * `:answer-schema` — the flexible structure the answer must match:
        - `%{"choice" => [variant, ...]}` — enum: one binding per variant.
        - `"bool"` — a toggle binding (`t` -> `true`/`false`).
        - `"string"` — a free-text fill (opens the composer as a minibuffer via
          the App's pending-fill state — see `App.pending_fill`).
    * `:resolves` — the mesh `:decision` seq this fill answers (`black/post`'s
      `:resolution` payload carries it as `"decision"`).
    * `:tier` — who may fill (`"human"` | `"policy"` | `"agent"` | `"any"`,
      default `"human"`). A `"policy"`-tiered slot generates NO human-facing
      affordance (doc 16's resolver symmetry: a policy resolves it instead).

  ## The bounded intent pool (atom-table-DoS discipline, PLAN-346 W3r)

  FEAT-020's own edge case: generated intents must REUSE a small fixed pool,
  never mint one per decision. This generator reuses EXACTLY ONE compiled
  intent family per schema kind — `hole/fill-choice`, `hole/fill-bool` — with
  the VARIANT/decision identity threaded through the CHORD'S BINDING and the
  REACTION'S CLOSURE DATA (both already string/atom-safe data, not fresh
  atoms), not through a new intent atom per slot. Any number of decisions
  share the same 2-3 intents; the atom table never grows with decision volume.

  ## Chord assignment (bounded, deterministic)

  Enum variants are assigned chords from a fixed pool in declaration order:
  `1..9` then `a..z` (35 slots before a schema is truncated — `variant_chords/1`
  is total and never raises past the pool; FEAT-020's own edge case: page/scroll
  a longer list rather than exhaust the keyspace — deferred to a FUP if a real
  schema ever needs more than 35 variants, an extreme case not seen in doc
  16/17's examples).

  ## Pure — zero TUI, zero registry writes

  This module computes DATA: `{bindings, reactions}` where `bindings` is
  `[{chord_string, intent_atom}]` and `reactions` is `[{intent_atom,
  ptc_source_string}]`. The CALLER (`SpellAgent.Tui.App`'s hole-affordance
  lifecycle, wired at cell-resolve time — see `App.sync_hole_affordances/1`)
  writes these into `KeymapRegistry` under the `:hole_affordance` context and
  tears them down when the slot leaves the tree. Kept pure and unit-testable
  with zero TUI per FEAT-020's own test list.
  """

  @typedoc "A generated chord/intent binding."
  @type binding :: {String.t(), atom()}

  @typedoc "A generated intent/PTC-source reaction."
  @type reaction :: {atom(), String.t()}

  @typedoc "The result of a schema render: nothing (policy-tiered) or the pair."
  @type result :: {[binding()], [reaction()]}

  # The bounded intent pool — EXACTLY these atoms, reused across every enum /
  # bool slot regardless of how many decisions exist. Compiled at build time
  # (not runtime-interned), so this list itself carries zero atom-DoS risk.
  @bool_true_intent :"hole/fill-true"
  @bool_false_intent :"hole/fill-false"
  @string_intent :"hole/fill-string"

  # Fixed chord pool for enum variants, in declaration order: 1-9 then a-z
  # (skipping letters that collide with the global/tree keymaps' own single-key
  # bindings is NOT attempted here — the :hole_affordance context is pushed to
  # the TOP of the resolver stack when a slot is focused, so it always wins;
  # see App.focus_stack/1's hole-affordance clause).
  @chord_pool for c <- ~c"123456789abcdefghijklmnopqrstuvwxyz", do: <<c>>

  @doc """
  Generate `{bindings, reactions}` for a `:slot` declaration, or `{[], []}` for
  a `:tier "policy"` slot (no human-facing affordance — doc 16 resolver
  symmetry) or a malformed/unrecognized schema (fails closed: no affordance
  rather than a crash).

  `resolves` is the mesh `:decision` seq (or any value) the fill's
  `:resolution` payload should carry under `"decision"`.
  """
  @spec generate(map()) :: result()
  def generate(%{} = slot) do
    tier = get(slot, "tier") || "human"

    if tier in ["policy"] do
      {[], []}
    else
      schema = get(slot, "answer-schema")
      resolves = get(slot, "resolves")
      by_schema(schema, resolves)
    end
  end

  def generate(_other), do: {[], []}

  # ---- schema kinds ----

  # Enum: {:choice [v1 v2 ...]} -> one chord per variant, ALL sharing the ONE
  # @choice_intent atom. The variant + decision-ref are DATA the reaction
  # closes over (embedded as a literal in the generated PTC source), never a
  # new atom.
  defp by_schema(%{"choice" => variants}, resolves) when is_list(variants) and variants != [] do
    variants
    |> Enum.with_index()
    |> Enum.reduce({[], []}, fn {variant, idx}, {binds, reacts} ->
      case Enum.at(@chord_pool, idx) do
        nil ->
          # Past the bounded chord pool (FEAT-020's own edge case): stop
          # generating further variants rather than exhausting/wrapping the
          # keyspace. A real schema this large needs pagination (a FUP).
          {binds, reacts}

        chord ->
          # Each variant needs its OWN intent to disambiguate which chord
          # fired (choice_intent_for/1 — still the BOUNDED, compile-time-fixed
          # pool, never a fresh atom per slot/decision). Binding and reaction
          # MUST key off the SAME intent for a given variant index.
          intent = choice_intent_for(idx)

          {[{chord, intent} | binds],
           [{intent, resolution_source(resolves, %{"choice" => to_string(variant)})} | reacts]}
      end
    end)
    |> finalize_choice()
  end

  # Bool: a SINGLE toggle chord ("t") posting `true`; a second variant ("f")
  # posts `false` explicitly rather than overloading one key with implicit
  # state (a fillable hole has no PRIOR answer to toggle FROM — each keypress
  # is a distinct, unambiguous resolution).
  defp by_schema("bool", resolves) do
    {
      [{"t", @bool_true_intent}, {"f", @bool_false_intent}],
      [
        {@bool_true_intent, resolution_source(resolves, %{"choice" => true})},
        {@bool_false_intent, resolution_source(resolves, %{"choice" => false})}
      ]
    }
  end

  # String: ONE chord ("i", mirrors "insert") arms the App's pending-fill state
  # (App.pending_fill) — the composer becomes the minibuffer; submitting posts
  # the typed text as the resolution. The reaction here is a MARKER intent the
  # App's compiled Global context intercepts (App-side effect, like
  # app/submit) — a pure Ui->Ui reaction cannot arm process state, so this
  # follows the SAME "App intercepts, reaction is identity" pattern
  # app/submit/app/reset-layout already use.
  defp by_schema("string", _resolves) do
    {[{"i", @string_intent}], []}
  end

  defp by_schema(_other, _resolves), do: {[], []}

  # Each enum variant needs its OWN intent to disambiguate which chord fired —
  # but "own intent" must still come from the BOUNDED pool, not a fresh atom
  # per slot. Reuses hole/fill-choice-0 .. hole/fill-choice-N, capped at the
  # SAME chord-pool size (35), which are COMPILED atoms (module attributes),
  # never runtime-interned — the pool is fixed at compile time regardless of
  # how many DECISIONS exist at runtime (the atom-DoS invariant FEAT-020 names).
  @choice_intents for i <- 0..(length(@chord_pool) - 1), into: %{}, do: {i, :"hole/fill-choice-#{i}"}

  defp choice_intent_for(idx), do: Map.fetch!(@choice_intents, idx)

  defp finalize_choice({binds, reacts}), do: {Enum.reverse(binds), Enum.reverse(reacts)}

  # ---- PTC reaction source (posts a :resolution via black/post) ----

  # The generated reaction body: post a :resolution record whose :decision is
  # the slot's :resolves ref and whose :answer is the fixed choice this chord
  # represents. `resolves`/`answer` are EMBEDDED AS LITERAL DATA in the source
  # (never as a new atom — both round-trip through the PTC reader's normal
  # string/int/bool/map literal forms), so the atom table is untouched no
  # matter how many decisions this generator ever answers.
  defp resolution_source(resolves, answer) do
    "(black/post {:kind \"resolution\" :payload {:decision #{ptc_literal(resolves)} " <>
      ":answer #{ptc_literal(answer)}}})"
  end

  # A minimal literal encoder for the handful of shapes a :resolves ref /
  # :answer map can take (string, integer, bool, nil, a flat string-keyed map).
  # NOT a general PTC formatter — deliberately narrow to what THIS generator
  # emits, so its output is trivially auditable.
  defp ptc_literal(s) when is_binary(s), do: ~s("#{escape(s)}")
  defp ptc_literal(n) when is_integer(n), do: Integer.to_string(n)
  defp ptc_literal(true), do: "true"
  defp ptc_literal(false), do: "false"
  defp ptc_literal(nil), do: "nil"

  defp ptc_literal(m) when is_map(m) do
    pairs =
      m
      |> Enum.map(fn {k, v} -> ":#{k} #{ptc_literal(v)}" end)
      |> Enum.join(" ")

    "{#{pairs}}"
  end

  defp ptc_literal(other), do: ptc_literal(to_string(other))

  defp escape(s), do: String.replace(s, "\"", "\\\"")

  # ---- helpers ----

  # A slot's fields arrive string- OR atom-keyed (the same PTC/Elixir duality
  # every layout-tree accessor tolerates) — never interns. Only ever called
  # with a map (both call sites guard on `%{}`), so no non-map clause exists.
  defp get(m, key) do
    case Map.fetch(m, key) do
      {:ok, v} -> v
      :error -> Map.get(m, safe_atom(key))
    end
  end

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end

  @doc "The bounded intent atoms this generator may ever bind (for tests/introspection)."
  @spec intent_pool() :: [atom()]
  def intent_pool do
    [@bool_true_intent, @bool_false_intent, @string_intent] ++ Map.values(@choice_intents)
  end
end
