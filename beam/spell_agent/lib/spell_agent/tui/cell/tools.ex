defmodule SpellAgent.Tui.Cell.Tools do
  @moduledoc """
  The read-only capability tier for reactive cells (PROJ-004 W1).

  A reactive cell evaluates an effectful query on the slow clock, but the spec is
  unambiguous: "looking never acts" must RELOCATE to "declare vs. resolve", never
  vanish. A cell may therefore call READ-ONLY query tools (forest/history reads)
  and NOTHING that mutates — not the keymap registry, not the durable store, not
  the shell, not the UI. This module is the one place that decides which verbs a
  cell may reach.

  ## Fail-closed allowlist (security is load-bearing here — spec)

  The danger is asymmetric: a missed mutator is catastrophic (a cell that edits
  the codebase or rebinds keys by being *displayed*), while a missed read merely
  makes a cell temporarily inert. So the policy is a fail-CLOSED ALLOWLIST, never
  a denylist: a verb reaches a cell ONLY if its name is in `@read_only_verbs`.
  Adding a NEW read verb is a deliberate one-line edit here; until then it is
  inert to cells — the safe failure mode. A new MUTATOR is invisible to cells for
  free, because it was never added.

  `@forbidden` lists verbs that are PROVABLY mutators. They are asserted ABSENT
  from the allowlist (the two sets are disjoint — `compile-time-checked` via the
  module attribute below and pinned by a test), so a future edit that accidentally
  widens the allowlist to include a mutator fails LOUDLY rather than silently
  granting it. Defense in depth around the allowlist, not a substitute for it.

  ## Source surface

  `read_only/2` filters `SpellAgent.Harness.tools/2` — whose own moduledoc splits
  `harness/*` (pure gaze transforms + forest queries) from `keymap/*` (registry
  mutators). The allowlist admits the `harness/*` reads and drops everything else,
  so the live-callers-pane demo (`harness/descendants` keyed by `harness/cursor-id`)
  works while `keymap/bind` and friends are unreachable.
  """

  alias SpellAgent.Harness

  # Fail-closed allowlist of read-only verb names a cell may call. Adding a new
  # read verb means adding it HERE (deliberate: a new verb is inert to cells until
  # vetted). A mutator must NEVER appear — see the disjointness invariant below.
  @read_only_verbs MapSet.new(~w(
    harness/state
    harness/cursor-id
    harness/descendants
    harness/ancestors
    harness/focus
    harness/cursor
    harness/expand
    harness/collapse
    harness/toggle
    harness/turn
    harness/scroll
  ))

  # Verbs that are PROVABLY mutators (or effects). Asserted absent from the
  # allowlist as defense in depth: a representative set spanning every mutating
  # namespace a cell could plausibly be mis-granted (keymap registry, durable
  # hist store, tool/config definition, shell). Pinned disjoint by a test.
  @forbidden MapSet.new(~w(
    keymap/bind
    keymap/unbind
    keymap/define-reaction
    hist/promote
    hist/crystallize
    define-tool
    define-config
    sh
    sh-pipe
    layout/set
    theme/set
  ))

  # Disjointness invariant, checked at COMPILE TIME: if a future edit puts a
  # forbidden name into the allowlist, the module fails to compile. The empty
  # intersection is the proof that no listed mutator is grantable.
  @disjoint MapSet.intersection(@read_only_verbs, @forbidden)
  if MapSet.size(@disjoint) > 0 do
    raise CompileError,
      description:
        "Cell.Tools allowlist contains forbidden mutators: #{inspect(MapSet.to_list(@disjoint))}"
  end

  @typedoc "A read-only tools map (verb name -> arity-1 callable)."
  @type t :: %{optional(String.t()) => (map() -> term())}

  @doc """
  Build the read-only tools tier a cell resolves against, for the given `forest`
  and `gaze`.

  Filters `Harness.tools/2` down to the vetted read-only allowlist. The result is
  safe to hand to `SpellAgent.Tui.Cell.resolve/3`: a cell can call any admitted
  read verb and NOTHING else — an unlisted or mutating verb is simply absent, so a
  query that calls it degrades to `:error` (unknown tool) rather than acting.
  """
  @spec read_only(map(), term()) :: t()
  def read_only(forest, gaze \\ nil) when is_map(forest) do
    forest
    |> Harness.tools(gaze)
    |> Map.filter(fn {name, _fun} -> allowed?(name) end)
  end

  @doc "Whether `name` is a vetted read-only verb a cell may call."
  @spec allowed?(String.t()) :: boolean()
  def allowed?(name) when is_binary(name), do: MapSet.member?(@read_only_verbs, name)
  def allowed?(_), do: false

  @doc "Whether `name` is a known mutator a cell must NEVER call (defense-in-depth set)."
  @spec forbidden?(String.t()) :: boolean()
  def forbidden?(name) when is_binary(name), do: MapSet.member?(@forbidden, name)
  def forbidden?(_), do: false

  @doc "The vetted read-only verb allowlist (for tests + introspection)."
  @spec read_only_verbs() :: MapSet.t()
  def read_only_verbs, do: @read_only_verbs

  @doc "The known-mutator denylist (for tests + introspection)."
  @spec forbidden_verbs() :: MapSet.t()
  def forbidden_verbs, do: @forbidden
end
