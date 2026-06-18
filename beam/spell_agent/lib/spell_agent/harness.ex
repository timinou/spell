defmodule SpellAgent.Harness do
  @moduledoc """
  The `harness/` + `keymap/` PTC-Lisp surfaces (PLAN-346 W3) — the homoiconic
  capstone of the Reaction DSL.

  Two sibling namespaces alongside `tool/` (routed through the same tool-call
  machinery by the vendored ptc_runner SPELL PATCH — see
  `ptc_runner-vendored/SPELL_PATCHES.md`), split by EFFECT PROFILE:

    * `harness/` — PURE gaze transforms + forest queries used INSIDE a reaction.
      A reaction body runs with the current gaze bound as `data/ui` and the span
      forest as `data/forest`; these verbs read/return that gaze:

          (harness/state)            -> the current Ui map
          (harness/cursor-id)        -> span id under the tree cursor
          (harness/descendants id)   -> [span-id] below id in the forest
          (harness/ancestors id)     -> [span-id] above id
          (harness/focus dir|pane)   -> Ui'   (:next | :prev | a pane)
          (harness/cursor delta)     -> Ui'   (int | :first | :last)
          (harness/expand id)        -> Ui'
          (harness/collapse id)      -> Ui'
          (harness/toggle id depth)  -> Ui'
          (harness/turn dir)         -> Ui'   (:next | :prev)
          (harness/scroll pane d)    -> Ui'

    * `keymap/` — the live-rebinding META-ops that MUTATE the KeymapRegistry
      (the homoiconic modifiability surface):

          (keymap/bind   {:chord "C-l" :intent "span/expand" :context "tree"})
          (keymap/unbind {:chord "C-l" :context "tree"})
          (keymap/show   {:context "tree"})    -> the live keymap as data
          (keymap/intents {:context "tree"})   -> the vocabulary available here
          (keymap/define-reaction
            {:context "tree" :intent "span/expand-all" :doc "..."
             :source "(reduce harness/expand (harness/state)
                              (harness/descendants (harness/cursor-id)))"})

  ## How the gaze threads through

  `harness/*` verbs are pure on a Ui VALUE. Inside a reaction the "current" gaze
  is whatever the program threads: `(harness/state)` reads `data/ui` (the gaze the
  App handed in), and each transform takes a gaze + returns a gaze, so a reaction
  is literally a fold over `data/ui` (see `SpellAgent.Tui.Reaction.Ptc`).

  The verbs accept a Ui either as a `%Ui{}` struct OR as the plain map a PTC
  program produces (string/atom keys), and always RETURN a plain map so the value
  round-trips cleanly through the sandbox boundary; `Reaction.Ptc` rehydrates the
  final map back into a `%Ui{}`.
  """

  alias SpellAgent.Tui.{Chord, KeymapRegistry, Ui}
  alias SpellAgent.Tui.Panes.SpanTree
  alias SpellAgent.Tui.Store

  @doc """
  The `harness/` + `keymap/` tool entries (qualified-name => `(args -> value)`),
  to merge into the tools map a reaction runs with.

  `forest` is the live span forest (`%{id => Span.t()}`) closed over so the query
  verbs can read it. `gaze` is the CURRENT gaze closed over so a verb called
  WITHOUT an explicit `:ui` (the ergonomic common case — `(harness/expand {:id …})`
  or a bare `(harness/state)`) operates on it. An explicit `:ui` in the call args
  still overrides, so a reaction can thread a different gaze if it wants.
  """
  @spec tools(map(), Ui.t() | nil) :: %{optional(String.t()) => (map() -> term())}
  def tools(forest, gaze \\ nil) when is_map(forest) do
    g = fn args -> gaze(args) || gaze end

    %{
      # ---- harness/ : pure gaze transforms + forest queries ----
      "harness/state" => fn args -> ui_map(to_ui(g.(args))) end,
      "harness/cursor-id" => fn args -> SpanTree.cursor_span_id(forest, to_ui(g.(args))) end,
      "harness/descendants" => fn args -> descendants(forest, arg(args, "id")) end,
      "harness/ancestors" => fn args -> ancestors(forest, arg(args, "id")) end,
      "harness/focus" => fn args -> ui_map(Ui.focus(to_ui(g.(args)), atomize(arg(args, "dir")))) end,
      "harness/cursor" => fn args -> ui_map(Ui.cursor(to_ui(g.(args)), cursor_delta(arg(args, "delta")))) end,
      "harness/expand" => fn args -> ui_map(Ui.expand(to_ui(g.(args)), expand_id(args, forest, g))) end,
      "harness/collapse" => fn args -> ui_map(Ui.collapse(to_ui(g.(args)), expand_id(args, forest, g))) end,
      "harness/toggle" => fn args -> ui_map(Ui.toggle(to_ui(g.(args)), arg(args, "depth") || 0, expand_id(args, forest, g))) end,
      "harness/turn" => fn args -> ui_map(Ui.turn(to_ui(g.(args)), atomize(arg(args, "dir")))) end,
      "harness/scroll" => fn args -> ui_map(Ui.scroll(to_ui(g.(args)), atomize(arg(args, "pane")), arg(args, "delta") || 0)) end,

      # ---- keymap/ : live-rebinding meta-ops (mutate the registry) ----
      "keymap/bind" => &keymap_bind/1,
      "keymap/unbind" => &keymap_unbind/1,
      "keymap/show" => &keymap_show/1,
      "keymap/intents" => &keymap_intents/1,
      "keymap/define-reaction" => &keymap_define_reaction/1
    }
  end

  @doc "Default forest-less tools (queries see an empty forest). For tests/util."
  @spec tools() :: map()
  def tools, do: tools(%{}, nil)

  # The id an expand/collapse/toggle acts on: an explicit :id, else the span under
  # the cursor (so `(harness/expand {})` expands the current selection — the
  # common reaction case, no need to compute cursor-id by hand).
  defp expand_id(args, forest, g) do
    arg(args, "id") || SpanTree.cursor_span_id(forest, to_ui(g.(args)))
  end

  # ---- gaze plumbing ----

  # A reaction passes its gaze positionally as the first arg or as {:ui ...}; the
  # harness verbs also default to `data/ui` when no explicit gaze is given. We
  # accept the gaze under the "ui" key (Reaction.Ptc threads it there) or fall
  # back to a fresh gaze.
  defp gaze(args) when is_map(args), do: Map.get(args, "ui") || Map.get(args, :ui)

  # Coerce whatever the program holds (a %Ui{}, a plain map with string/atom keys,
  # or nil) into a %Ui{} for the pure transforms.
  defp to_ui(%Ui{} = ui), do: ui
  defp to_ui(nil), do: Ui.new()

  defp to_ui(m) when is_map(m) do
    %Ui{
      focus: Ui.safe_pane(get(m, "focus")) || :tree,
      panes: safe_panes(get(m, "panes")),
      cursors: keymapize(get(m, "cursors")),
      auto_depth: safe_int(get(m, "auto_depth"), 1),
      overrides: stringkeyize(get(m, "overrides")),
      turn: safe_int(get(m, "turn"), 0),
      scroll: keymapize(get(m, "scroll")),
      # leader is reserved (modal layers); only a known pane atom is accepted,
      # else nil — never interned from a reaction string.
      leader: Ui.safe_pane(get(m, "leader"))
    }
  end

  # A pane list coerced to known panes (unknowns dropped), defaulting to the full
  # ring when absent/empty.
  defp safe_panes(nil), do: [:tree, :answer, :prompt]

  defp safe_panes(list) when is_list(list) do
    case Enum.flat_map(list, fn p -> List.wrap(Ui.safe_pane(p)) end) do
      [] -> [:tree, :answer, :prompt]
      panes -> panes
    end
  end

  defp safe_panes(_), do: [:tree, :answer, :prompt]

  # A non-negative integer, else the default — a reaction can't inject a non-int
  # (e.g. a string) that would later crash a numeric comparison in the projection.
  defp safe_int(n, _default) when is_integer(n) and n >= 0, do: n
  defp safe_int(_, default), do: default

  # Render a %Ui{} back to a plain string-keyed map for the sandbox boundary.
  defp ui_map(%Ui{} = ui) do
    %{
      "focus" => to_string(ui.focus),
      "panes" => Enum.map(ui.panes, &to_string/1),
      "cursors" => stringify_kv(ui.cursors),
      "auto_depth" => ui.auto_depth,
      "overrides" => stringify_kv(ui.overrides),
      "turn" => ui.turn,
      "scroll" => stringify_kv(ui.scroll),
      "leader" => ui.leader && to_string(ui.leader)
    }
  end

  defp ui_map(other), do: other

  # ---- forest queries ----

  defp descendants(_forest, nil), do: []

  defp descendants(forest, id) do
    case Store.subtree(forest, id) do
      [_self | rest] -> Enum.map(rest, & &1.id)
      _ -> []
    end
  end

  defp ancestors(forest, id), do: ancestors(forest, id, [])
  defp ancestors(_forest, nil, acc), do: Enum.reverse(acc)

  defp ancestors(forest, id, acc) do
    case forest[id] do
      %{parent_id: nil} -> Enum.reverse(acc)
      %{parent_id: pid} when is_binary(pid) -> ancestors(forest, pid, [pid | acc])
      _ -> Enum.reverse(acc)
    end
  end

  # ---- keymap/ meta-ops ----

  defp keymap_bind(args) do
    ctx = require_context(args)
    chord = Chord.parse(require_str(args, "chord"))
    intent = require_existing_intent(args)
    :ok = KeymapRegistry.bind(ctx, chord, intent)
    %{"ok" => true, "bound" => Chord.to_string(chord), "intent" => to_string(intent), "context" => to_string(ctx)}
  end

  defp keymap_unbind(args) do
    ctx = require_context(args)
    chord = Chord.parse(require_str(args, "chord"))
    :ok = KeymapRegistry.unbind(ctx, chord)
    %{"ok" => true, "unbound" => Chord.to_string(chord), "context" => to_string(ctx)}
  end

  defp keymap_show(args) do
    ctx = require_context(args)

    KeymapRegistry.bindings(ctx)
    |> Enum.map(fn {chord, intent} -> %{"chord" => Chord.to_string(chord), "intent" => to_string(intent)} end)
  end

  defp keymap_intents(args) do
    ctx = require_context(args)
    reactions = KeymapRegistry.reactions(ctx) |> Enum.map(fn {intent, _src} -> to_string(intent) end)
    %{"context" => to_string(ctx), "reactions" => reactions}
  end

  defp keymap_define_reaction(args) do
    ctx = require_context(args)
    source = require_str(args, "source")
    # define-reaction is the ONE place a NEW intent atom may be created. It is
    # bounded: KeymapRegistry.define_intent/1 caps the number of runtime intents
    # and requires the `domain/verb` shape, so a sandboxed reaction can't grow the
    # atom table without limit (atom-table-DoS defense, PLAN-346 W3r).
    case KeymapRegistry.define_intent(require_str(args, "intent")) do
      {:ok, intent} ->
        case PtcRunner.Lisp.validate(source) do
          :ok ->
            :ok = KeymapRegistry.put_reaction(ctx, intent, source)
            %{"ok" => true, "defined" => to_string(intent), "context" => to_string(ctx)}

          {:error, messages} ->
            raise ArgumentError,
                  "define-reaction #{inspect(to_string(intent))} has invalid PTC source: #{Enum.join(List.wrap(messages), "; ")}"
        end

      {:error, reason} ->
        raise ArgumentError, "define-reaction rejected intent: #{reason}"
    end
  end

  # Known keymap contexts — EXACTLY the contexts the resolver consults
  # (App.focus_stack: SpanTree=:tree, TurnNav=:turn_nav for answer/prompt focus,
  # and :global). A reaction-supplied context string is matched by VALUE (never
  # interned — atom-table DoS guard). NB :answer/:prompt are deliberately NOT
  # here: both panes resolve through :turn_nav, so a binding stored under :answer
  # would be silently ignored by Keys.resolve (final-review P2). Bind those keys
  # under "turn_nav".
  @contexts [:tree, :turn_nav, :prompt, :global]

  defp require_context(args) do
    s = require_str(args, "context")

    case Enum.find(@contexts, &(Atom.to_string(&1) == s)) do
      nil ->
        raise ArgumentError,
              "unknown context #{inspect(s)}; allowed: #{Enum.map_join(@contexts, ", ", &to_string/1)} " <>
                "(the answer + prompt panes both use \"turn_nav\")"

      ctx ->
        ctx
    end
  end

  # An intent to BIND must already exist (a compiled verb or a previously-defined
  # reaction): use to_existing_atom so a typo/attacker string can't intern.
  defp require_existing_intent(args) do
    s = require_str(args, "intent")

    try do
      String.to_existing_atom(s)
    rescue
      ArgumentError ->
        reraise ArgumentError,
                [message: "unknown intent #{inspect(s)}; define it first with keymap/define-reaction"],
                __STACKTRACE__
    end
  end

  # ---- small helpers ----

  defp arg(args, key) when is_map(args), do: Map.get(args, key) || Map.get(args, safe_atom(key))
  defp get(m, key) when is_map(m), do: Map.get(m, key) || Map.get(m, safe_atom(key))
  defp get(_m, _key), do: nil

  # Cursor delta: an int, or :first/:last (passed as strings from PTC).
  defp cursor_delta(n) when is_integer(n), do: n
  defp cursor_delta(s) when is_binary(s), do: Ui.safe_dir(s) || 0
  defp cursor_delta(_), do: 0

  # ATOM SAFETY (PLAN-346 W3r): a reaction's strings are untrusted; never
  # `String.to_atom` them (atom-table DoS). These coercions go through Ui's
  # bounded vocabularies, interning nothing.
  defp atomize(nil), do: nil
  defp atomize(a) when is_atom(a), do: a
  # `atomize` is only ever used on pane/dir/visibility-domain values here, so
  # route binaries through the bounded coercions (pane first, then dir).
  defp atomize(s) when is_binary(s), do: Ui.safe_pane(s) || Ui.safe_dir(s)

  # cursors/scroll maps are keyed by PANE atoms; coerce keys safely, dropping any
  # unknown key rather than interning it.
  defp keymapize(nil), do: %{}

  defp keymapize(m) when is_map(m) do
    for {k, v} <- m, p = Ui.safe_pane(k), into: %{}, do: {p, v}
  end

  # overrides are keyed by span-id STRINGS (kept as strings — no atomization) with
  # :expanded/:collapsed VALUES (bounded).
  defp stringkeyize(nil), do: %{}

  defp stringkeyize(m) when is_map(m) do
    for {k, v} <- m, vis = Ui.safe_visibility(v), into: %{}, do: {to_string(k), vis}
  end

  defp stringify_kv(m) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string(k), stringify_val(v)} end)
  defp stringify_val(v) when is_atom(v) and not is_nil(v), do: to_string(v)
  defp stringify_val(v), do: v

  defp require_str(args, key) do
    case arg(args, key) do
      s when is_binary(s) and s != "" -> s
      other -> raise ArgumentError, "#{key} must be a non-empty string, got #{inspect(other)}"
    end
  end



  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end
end
