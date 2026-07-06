defmodule SpellAgent.Namespace do
  @moduledoc """
  The single source of truth for the agent's callable namespaces (PLAN-025 W1,
  FEAT-035).

  Before this module, a namespace's verbs were registered by N ad-hoc
  `Map.merge` sites (`Tools.build_tools_map/0`, `Session.build_session_tools/5`,
  each `*/namespace.ex` builder) with a SEPARATE hand-maintained `inventory/0`
  mirror for the LLM prompt, and — for the bare-routed namespaces — a THIRD
  hand-maintained allowlist in the vendored `ptc_runner` analyzer. Three places
  to edit per verb, drift-prone, and the inventory silently omitted most of the
  surface.

  PLAN-025 W1 collapsed the analyzer allowlist (ptc_runner PATCH-Q: any
  `ns/verb` under a bounded prefix routes as a binary tool name, no per-verb
  interning). This module collapses the remaining two: a namespace is
  DECLARED once as a `%Spec{}`, and every consumer derives from it:

    * `tools_map/1`   — the name -> `(args -> value)` map for the SubAgent.
    * `inventory/1`   — the `%{"name","params","doc","kind"}` list for the
      `list-tools` tool AND the system-prompt capability description (FEAT-034).
    * `verb_names/1`  — the flat set of callable names (for the define-tool
      closed-world callee check, BUG-027).
    * `verify_atom_safety/0` — a drift guard asserting every bare-routed prefix
      is bounded in `ptc_runner`'s `SourceAtoms`, so a new bare namespace can
      never silently fail to parse.

  ## Routing

    * `:bare`  — called as `(prefix/verb …)` (e.g. `(harness/expand)`). Requires
      the `prefix` to be in `SourceAtoms.bounded_namespaces/0` (a one-time,
      stable, few-entry list). The verb member is never interned (PATCH-Q).
    * `:tool`  — called as `(tool/prefix/verb …)` (e.g. `(tool/hist/reduce)`).
      The whole `prefix/verb` is a plain string key under the already-bounded
      `tool/` prefix. Zero ptc_runner coupling.

  ## Scope

    * `:static`  — the verb set + closures do not depend on a session. Built
      once (`builder` is a 0-ary fun returning the tools map, or `nil` when the
      verbs carry inline `fun`s).
    * `:session` — the verbs close over per-session context (session id, store,
      llm, attenuation). `builder` is a fun of `ctx` (a
      `SpellAgent.Namespace.Context` map) returning the tools map.

  ## Effect profile

  `:pure | :read | :mutating | :meta` — declared metadata used by attenuation
  and (later) reaction-safety policy. Recorded now so the boundary is explicit;
  enforcement hooks land as they are needed.

  ## Never brick the surface

  A namespace `builder` that raises (e.g. a registry not running in a bare unit
  test) degrades to an empty verb set for that namespace — the agent surface is
  always buildable — mirroring the pre-existing `freeform_tools/0` rescue.
  """

  alias SpellAgent.Namespace.Spec

  defmodule Verb do
    @moduledoc "One callable verb's metadata (name is the UNqualified member)."
    @enforce_keys [:name]
    defstruct [:name, params: [], doc: "", fun: nil]

    @type t :: %__MODULE__{
            name: String.t(),
            params: [String.t()],
            doc: String.t(),
            fun: (map() -> term()) | nil
          }
  end

  defmodule Spec do
    @moduledoc "A namespace declaration — the single source of truth for one namespace."
    @enforce_keys [:prefix, :routing, :scope]
    defstruct [
      :prefix,
      :routing,
      :scope,
      effect: :read,
      verbs: [],
      builder: nil,
      kind: "native"
    ]

    @type routing :: :bare | :tool
    @type scope :: :static | :session
    @type effect :: :pure | :read | :mutating | :meta

    @type t :: %__MODULE__{
            prefix: String.t(),
            routing: routing(),
            scope: scope(),
            effect: effect(),
            verbs: [SpellAgent.Namespace.Verb.t()],
            builder: (map() -> map()) | (-> map()) | nil,
            kind: String.t()
          }
  end

  defmodule Context do
    @moduledoc "Per-session context threaded to `:session`-scoped namespace builders."
    defstruct [:session_id, :hist_store, :llm, :max_turns, :region, :budget, allowed: :all]

    @type t :: %__MODULE__{
            session_id: String.t() | nil,
            hist_store: term(),
            llm: term(),
            max_turns: non_neg_integer() | nil,
            region: String.t() | nil,
            # FEAT-043: this session's enforced resource ceiling. spawn/ clamps a
            # child's requested budget by this (capability + resource only narrow).
            budget: SpellAgent.Budget.t() | nil,
            allowed: :all | [String.t()]
          }
  end

  @doc """
  The SOURCE display form for a verb — how the agent writes the call.

  A verb's `name` is its exact tools-map key (`"sh"`, `"hist/reduce"`,
  `"black/post"`, `"spawn-session"`). The display form depends on ROUTING:

    * `:tool`  — agent writes `(tool/<name>)`  -> display `"tool/<name>"`.
    * `:bare`  — agent writes `(<name>)` (the name already carries its prefix)
      -> display `"<name>"`.
  """
  @spec display_name(Spec.routing(), String.t()) :: String.t()
  def display_name(:tool, name), do: "tool/" <> name
  def display_name(:bare, name), do: name

  @doc """
  Build the name -> callable map for every `:static` namespace in `specs`.

  Session namespaces are folded separately via `session_tools_map/2` with a
  `Context`. Each namespace degrades to `%{}` if its builder raises.
  """
  @spec static_tools_map([Spec.t()]) :: %{optional(String.t()) => (map() -> term())}
  def static_tools_map(specs) do
    specs
    |> Enum.filter(&(&1.scope == :static))
    |> Enum.reduce(%{}, fn spec, acc -> Map.merge(acc, safe_build(spec, nil)) end)
  end

  @doc """
  Fold every `:session` namespace in `specs` with the given `Context` into one
  merged tools map. Each namespace degrades to `%{}` if its builder raises.
  """
  @spec session_tools_map([Spec.t()], Context.t()) ::
          %{optional(String.t()) => (map() -> term())}
  def session_tools_map(specs, %Context{} = ctx) do
    specs
    |> Enum.filter(&(&1.scope == :session))
    |> Enum.reduce(%{}, fn spec, acc -> Map.merge(acc, safe_build(spec, ctx)) end)
  end

  @doc """
  The capability inventory for a set of specs: one `%{"name","params","doc",
  "kind"}` per verb, in declaration order. This is the SINGLE source the
  `list-tools` tool and the system-prompt capability description both read
  (FEAT-034) — no hand-maintained mirror.

  Verbs are named by their qualified callable name (`"prefix/verb"`) so the LLM
  sees exactly what it types.
  """
  @spec inventory([Spec.t()]) :: [map()]
  def inventory(specs) do
    Enum.flat_map(specs, fn spec ->
      Enum.map(spec.verbs, fn %Verb{} = v ->
        %{
          "name" => display_name(spec.routing, v.name),
          "params" => Enum.map(v.params, &to_string/1),
          "doc" => v.doc,
          "kind" => spec.kind,
          "namespace" => spec.prefix,
          "effect" => to_string(spec.effect)
        }
      end)
    end)
  end

  @doc """
  The flat set of every qualified callable name across `specs` (for the
  define-tool closed-world callee check, BUG-027).
  """
  @spec verb_names([Spec.t()]) :: MapSet.t(String.t())
  def verb_names(specs) do
    for spec <- specs, v <- spec.verbs, into: MapSet.new(), do: v.name
  end

  @doc """
  Drift guard: every `:bare`-routed namespace prefix MUST be a bounded prefix in
  ptc_runner's `SourceAtoms`, else `(prefix/verb …)` would fail to parse. Returns
  `:ok` or `{:error, [missing_prefix]}`. A test asserts this so adding a bare
  namespace without bounding its prefix fails loudly.
  """
  @spec verify_atom_safety([Spec.t()]) :: :ok | {:error, [String.t()]}
  def verify_atom_safety(specs) do
    bounded = MapSet.new(PtcRunner.Lisp.SourceAtoms.bounded_namespaces())

    missing =
      for %Spec{prefix: p, routing: :bare} <- specs,
          not MapSet.member?(bounded, p),
          do: p

    case missing do
      [] -> :ok
      list -> {:error, Enum.uniq(list)}
    end
  end

  # Build one namespace's verb map, degrading to %{} on failure so the surface
  # is never bricked. A namespace supplies its verbs one of two ways:
  #   * inline `fun`s on each %Verb{}  -> build the map directly.
  #   * a `builder` fun                -> call it (static: 0-arity | session: ctx).
  # When both are present the builder wins (it may add verbs beyond the declared
  # metadata, e.g. reflected view/* widgets).
  defp safe_build(%Spec{} = spec, ctx) do
    build(spec, ctx)
  rescue
    _ -> %{}
  catch
    :exit, _ -> %{}
  end

  defp build(%Spec{builder: builder} = spec, ctx) when is_function(builder) do
    cond do
      spec.scope == :session and is_function(builder, 1) -> builder.(ctx)
      spec.scope == :static and is_function(builder, 0) -> builder.()
      true -> raise ArgumentError, "namespace #{spec.prefix}: builder arity mismatch"
    end
  end

  defp build(%Spec{builder: nil, verbs: verbs}, _ctx) do
    Map.new(verbs, fn %Verb{name: name, fun: fun} ->
      {name, fun || raise(ArgumentError, "verb #{name} missing :fun")}
    end)
  end
end
