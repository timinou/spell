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

  ## Durability (PLAN-024 Wave 4 / FUP-009)

  v0 storage is in-memory (Agent-backed), session-scoped — same posture as
  `ToolRegistry` before its own W3 durability wave. Mirrors that EXACT pattern
  (`docs/durable-toolset.md`): opt-in via `start_link(durable: true)`, mirrored
  to `Hist.Store` under `{:keymap, name}` on every mutating call, rehydrated on
  boot with a best-effort fallback to an empty override set. `Hist.Store.Khepri`
  is already per-project (`File.cwd!()/.spell/forest`), so one fixed durable name
  IS per-project durability — no separate project-key scheme.

  A runtime-interned INTENT ATOM is never itself persisted as a bare atom (atoms
  don't serialize meaningfully across a fresh BEAM's atom table); the STORED
  form keys bindings/reactions by the intent's STRING spelling, and rehydration
  re-interns through `define_intent/1` (the SAME bounded chokepoint a live
  `keymap/define-reaction` uses) — so a rehydrated durable keymap costs AT MOST
  the same atom-table budget a fresh session authoring it live would.
  """

  use Agent

  alias SpellAgent.Hist
  alias SpellAgent.Hist.Store
  alias SpellAgent.Tui.Chord

  @type context :: atom()
  @type intent :: atom()
  @type state :: %{bindings: %{{context(), Chord.t()} => intent()}, reactions: %{{context(), intent()} => String.t()}}

  # Cap on how many DISTINCT runtime intent atoms may be created via
  # `define_intent/1`. Atoms are never GC'd, so this bounds the atom-table growth
  # a (sandboxed, untrusted) reaction can cause through keymap/define-reaction
  # (atom-table-DoS defense, PLAN-346 W3r). The compiled intents already exist as
  # atoms and don't count against this.
  @max_runtime_intents 256

  # A runtime intent must look like `domain/verb` (lowercase, hyphen/underscore),
  # mirroring the compiled vocabulary — not an arbitrary string.
  @intent_pattern ~r{\A[a-z][a-z0-9_-]*/[a-z][a-z0-9_-]*\z}

  # Max intent-name length. `String.to_atom/1` RAISES for names past the VM atom
  # limit (255 bytes), which would crash this Agent callback and restart the live
  # registry (final-review P2). A real `domain/verb` intent is short; reject
  # anything longer BEFORE interning.
  @max_intent_bytes 128

  @default_durable_name "default"

  @doc """
  Start the registry. `:durable` (boolean, default `false`) opts into PLAN-024
  Wave 4 durability: rehydrates persisted bindings/reactions from `Hist.Store`
  (under `:durable_name`, default `"default"`) into the live maps, RE-INTERNING
  each stored intent string through `define_intent/1` (so a corrupt/oversized/
  malformed persisted intent name degrades to being SKIPPED, never crashes
  boot). `:store` overrides the store module (defaults to `Hist.default_store/0`).
  """
  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(opts \\ []) do
    durable? = Keyword.get(opts, :durable, false)
    store = Keyword.get(opts, :store, Hist.default_store())
    durable_name = Keyword.get(opts, :durable_name, @default_durable_name)

    Agent.start_link(
      fn ->
        base = %{bindings: %{}, reactions: %{}, intents: MapSet.new()}
        seeded = if durable?, do: rehydrate_into(base, store, durable_name), else: base
        Map.merge(seeded, %{durable?: durable?, durable_name: durable_name, store: store})
      end,
      name: __MODULE__
    )
  end

  @doc """
  Resolve a runtime intent NAME (string) to an atom, creating the atom at most
  once and only within bounds (the single controlled atom-creation point for
  reaction-authored intents).

  Returns `{:ok, atom}` or `{:error, reason}`. Rules:
    * if the atom already exists (a compiled intent or one defined earlier),
      reuse it — no new atom;
    * else require the `domain/verb` shape AND that the runtime-intent count is
      under `@max_runtime_intents`, then create + record it.
  """
  @spec define_intent(String.t()) :: {:ok, intent()} | {:error, String.t()}
  def define_intent(name) when is_binary(name) do
    Agent.get_and_update(__MODULE__, fn s ->
      case pure_define_intent(s, name) do
        {:ok, atom, new_s} -> {{:ok, atom}, new_s}
        {:error, reason} -> {{:error, reason}, s}
      end
    end)
  end

  # The SAME bounded-intern logic define_intent/1 uses, but as a PURE fn over an
  # explicit state map — shared with `rehydrate_into/3`, which runs BEFORE the
  # Agent process is registered (inside start_link's init fn) and so cannot call
  # back into `Agent.get_and_update(__MODULE__, ...)` without deadlocking.
  defp pure_define_intent(s, name) do
    case existing_atom(name) do
      {:ok, atom} ->
        {:ok, atom, s}

      :error ->
        cond do
          byte_size(name) > @max_intent_bytes ->
            {:error, "intent name too long (max #{@max_intent_bytes} bytes)"}

          not Regex.match?(@intent_pattern, name) ->
            {:error, "intent must match domain/verb (got #{inspect(name)})"}

          MapSet.size(s.intents) >= @max_runtime_intents ->
            {:error, "runtime intent limit reached (#{@max_runtime_intents})"}

          true ->
            atom = String.to_atom(name)
            {:ok, atom, %{s | intents: MapSet.put(s.intents, atom)}}
        end
    end
  end

  defp existing_atom(name) do
    {:ok, String.to_existing_atom(name)}
  rescue
    ArgumentError -> :error
  end

  # ---- bindings (chord -> intent) ----

  # Contexts EXCLUDED from durability: :hole_affordance is a DERIVED context
  # (PLAN-024 Wave 3) — App.sync_hole_affordances/1 regenerates it from the
  # focused node's tree declaration on every navigation step (potentially every
  # keystroke). Persisting it would (a) churn a disk write per keystroke and (b)
  # durably freeze ephemeral per-navigation state that is already fully
  # reproducible from the tree — exactly why `LayoutRegistry.replace/1` excludes
  # gaze re-tags from its own mirror. Mirrors that same exclusion here.
  @excluded_from_durability [:hole_affordance]

  @doc "Bind a chord to an intent in a context (shadows the compiled keymap)."
  @spec bind(context(), Chord.t(), intent()) :: :ok
  def bind(context, %Chord{} = chord, intent) when is_atom(context) and is_atom(intent) do
    Agent.update(__MODULE__, fn s ->
      new_s = put_in(s.bindings[{context, chord}], intent)
      unless context in @excluded_from_durability, do: maybe_persist(new_s)
      new_s
    end)
  end

  @doc "Remove a live binding for a chord in a context (reveals the compiled one)."
  @spec unbind(context(), Chord.t()) :: :ok
  def unbind(context, %Chord{} = chord) when is_atom(context) do
    Agent.update(__MODULE__, fn s ->
      new_s = update_in(s.bindings, &Map.delete(&1, {context, chord}))
      unless context in @excluded_from_durability, do: maybe_persist(new_s)
      new_s
    end)
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
  @doc """
  The distinct context names that currently hold at least one live binding.

  Introspection for `KeymapIntrospect` (FEAT-047): a runtime `keymap/bind` to a
  fresh context atom (a declared-at-runtime pane with no compiled module) is
  discoverable only if the reflector can ENUMERATE which contexts have live
  bindings. Returns `[]` if the registry is down.
  """
  @spec binding_contexts() :: [atom()]
  def binding_contexts do
    Agent.get(__MODULE__, fn s ->
      s.bindings |> Map.keys() |> Enum.map(fn {ctx, _chord} -> ctx end) |> Enum.uniq()
    end)
  end
  # ---- reactions (intent -> ptc source) ----

  @doc "Store a runtime-authored reaction (PTC source) for an intent in a context."
  @spec put_reaction(context(), intent(), String.t()) :: :ok
  def put_reaction(context, intent, source) when is_atom(context) and is_atom(intent) and is_binary(source) do
    Agent.update(__MODULE__, fn s ->
      new_s = put_in(s.reactions[{context, intent}], source)
      unless context in @excluded_from_durability, do: maybe_persist(new_s)
      new_s
    end)
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

  @doc """
  Wipe every binding + reaction under ONE context, leaving every other context's
  overrides untouched (PLAN-024 Wave 3 / FEAT-020 — the hole-affordance
  lifecycle teardown: a slot's generated chords are re-derived on every
  navigation step via `clear_context/1` then a fresh `bind`/`put_reaction`
  install, so a slot leaving focus/the tree cannot leave a dangling chord
  behind). Intents already interned stay interned (never un-interns an atom —
  atom-DoS posture is a one-way ratchet by design); only the {context, _}
  entries are dropped.
  """
  @spec clear_context(context()) :: :ok
  def clear_context(context) when is_atom(context) do
    Agent.update(__MODULE__, fn s ->
      new_s = %{
        s
        | bindings: for({k, v} <- s.bindings, not match?({^context, _}, k), into: %{}, do: {k, v}),
          reactions: for({k, v} <- s.reactions, not match?({^context, _}, k), into: %{}, do: {k, v})
      }

      unless context in @excluded_from_durability, do: maybe_persist(new_s)
      new_s
    end)
  end

  @doc """
  Wipe all overrides AND their persisted mirror (`{:keymap, name}` in the durable
  store, when this boot is durable). No-op on the store when not durable.
  """
  @spec reset() :: :ok
  def reset do
    Agent.update(__MODULE__, fn s ->
      new_s = %{s | bindings: %{}, reactions: %{}, intents: MapSet.new()}
      maybe_persist(new_s)
      new_s
    end)
  end

  # ---- durability (PLAN-024 Wave 4 / FUP-009) ----

  @doc "Whether THIS registry process was booted with durability enabled."
  @spec durable?() :: boolean()
  def durable?, do: Agent.get(__MODULE__, &Map.get(&1, :durable?, false))

  @doc """
  Enable durability on the ALREADY-RUNNING supervised registry singleton, and
  (unless `rehydrate: false`) immediately rehydrate + merge in persisted
  bindings/reactions (mirrors `LayoutRegistry.enable_durability/1`'s rationale:
  this registry is started once, with fixed opts, by the app supervisor at boot
  — before a CLI flag like `mix spell.tui --durable` is known). Rehydrated
  entries MERGE onto whatever is already live (never wipe existing bindings from
  this launch); a persisted entry that fails to resolve (unknown context/intent
  shape) is skipped, matching `rehydrate_into/3`'s boot-time posture.
  """
  @spec enable_durability(keyword()) :: :ok
  def enable_durability(opts \\ []) do
    store = Keyword.get(opts, :store, Hist.default_store())
    durable_name = Keyword.get(opts, :durable_name, @default_durable_name)
    rehydrate? = Keyword.get(opts, :rehydrate, true)

    Agent.update(__MODULE__, fn s ->
      merged = if rehydrate?, do: rehydrate_into(s, store, durable_name), else: s
      %{merged | durable?: true, store: store, durable_name: durable_name}
    end)
  end

  @doc "Force-persist the current bindings/reactions right now. No-op when not durable."
  @spec persist() :: :ok
  def persist, do: Agent.get(__MODULE__, &maybe_persist/1)

  # Mirror the durability-eligible slice of `s` (bindings/reactions, EXCLUDING
  # @excluded_from_durability contexts, keyed by STRING spellings so the record
  # is plain serializable data — no atoms) to `{:keymap, s.durable_name}`. A
  # no-op when this boot is not durable. Called from INSIDE the same Agent
  # callback as the map update it mirrors (the ToolRegistry discipline).
  defp maybe_persist(%{durable?: true} = s) do
    snapshot = %{
      "bindings" =>
        for {{ctx, chord}, intent} <- s.bindings, ctx not in @excluded_from_durability do
          %{"context" => to_string(ctx), "chord" => Chord.to_string(chord), "intent" => to_string(intent)}
        end,
      "reactions" =>
        for {{ctx, intent}, source} <- s.reactions, ctx not in @excluded_from_durability do
          %{"context" => to_string(ctx), "intent" => to_string(intent), "source" => source}
        end
    }

    safe_store(fn -> Store.put(s.store, {:keymap, s.durable_name}, snapshot) end)
  end

  defp maybe_persist(_s), do: :ok

  @doc """
  Rehydrate a persisted `{:keymap, name}` snapshot INTO `s0` (a state map shaped
  like the registry's own — `%{bindings: %{}, reactions: %{}, intents:
  MapSet.new()}` at minimum). Each binding/reaction entry re-derives its CONTEXT
  atom via `String.to_existing_atom/1` (a context is always either a compiled
  pane-context module atom or a PLAN-024-Wave-1 runtime pane name already known
  to `PaneRegistry` — either way already-interned by the time a durable boot's
  App re-seeds its panes, so this never interns a NEW atom) and its INTENT atom
  via the bounded `pure_define_intent/2`-equivalent logic (the SAME chokepoint a
  live `keymap/define-reaction` uses). Any entry whose context/intent/chord
  fails to resolve is SKIPPED, not fatal — one corrupt record never bricks the
  whole durable keymap.

  Public (mirrors `ToolRegistry.durable_map/1`'s reasoning): `KeymapRegistry` is
  a NAMED singleton started once by the app supervisor, so a test cannot easily
  drive `start_link/1`'s rehydration path directly — this is the SAME logic
  `start_link/1` and `enable_durability/1` call, exposed so the projection is
  independently testable against a pre-populated store. Pure: runs (and is
  meant to run) BEFORE the Agent process exists, so it never calls back through
  `Agent.get_and_update(__MODULE__, ...)`.
  """
  @spec rehydrate_into(state(), module(), String.t()) :: state()
  def rehydrate_into(s0, store, name) do
    ensure_store_started(store)

    case safe_fetch(store, {:keymap, name}) do
      {:ok, %{} = snapshot} -> fold_snapshot(s0, snapshot)
      _ -> s0
    end
  end

  defp fold_snapshot(s0, snapshot) do
    s1 =
      snapshot
      |> Map.get("bindings", [])
      |> List.wrap()
      |> Enum.reduce(s0, &fold_binding/2)

    snapshot
    |> Map.get("reactions", [])
    |> List.wrap()
    |> Enum.reduce(s1, &fold_reaction/2)
  end

  defp fold_binding(%{"context" => ctx_s, "chord" => chord_s, "intent" => intent_s}, s)
       when is_binary(ctx_s) and is_binary(chord_s) and is_binary(intent_s) do
    with {:ok, ctx} <- safe_existing_atom(ctx_s),
         {:ok, chord} <- safe_parse_chord(chord_s),
         {:ok, intent, s1} <- pure_define_intent(s, intent_s) do
      put_in(s1.bindings[{ctx, chord}], intent)
    else
      _ -> s
    end
  end

  defp fold_binding(_malformed, s), do: s

  defp fold_reaction(%{"context" => ctx_s, "intent" => intent_s, "source" => source}, s)
       when is_binary(ctx_s) and is_binary(intent_s) and is_binary(source) do
    with {:ok, ctx} <- safe_existing_atom(ctx_s),
         {:ok, intent, s1} <- pure_define_intent(s, intent_s) do
      put_in(s1.reactions[{ctx, intent}], source)
    else
      _ -> s
    end
  end

  defp fold_reaction(_malformed, s), do: s

  defp safe_existing_atom(s) when is_binary(s) do
    {:ok, String.to_existing_atom(s)}
  rescue
    ArgumentError -> :error
  end

  defp safe_parse_chord(s) when is_binary(s) do
    {:ok, Chord.parse(s)}
  rescue
    _ -> :error
  end

  defp ensure_store_started(store) do
    cond do
      function_exported?(store, :start, 0) -> safe_store(fn -> store.start() end)
      function_exported?(store, :start, 1) -> safe_store(fn -> store.start(nil) end)
      true -> :ok
    end
  end

  defp safe_fetch(store, key) do
    Store.fetch(store, key)
  rescue
    _ -> :error
  catch
    :exit, _ -> :error
  end

  defp safe_store(fun) do
    fun.()
    :ok
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end
end
