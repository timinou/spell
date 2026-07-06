defmodule SpellAgent.Tools do
  @moduledoc """
  The homoiconic tool surface (FEAT-826, PLAN-344).

  Builds the `tools` map that `PtcRunner.SubAgent` hands to the PTC-Lisp
  evaluator, where every entry is a `(args_map -> value)` function (the verified
  `invoke_tool` contract). Two kinds of entry live in `SpellAgent.ToolRegistry`:

    * `:native` — an Elixir function (the `define-*` meta-tools, plus any
      built-ins we wire in later such as a NIF-backed `find`).
    * `:ptc`    — PTC-Lisp SOURCE TEXT authored at runtime. This is the
      homoiconic core: a tool the agent writes is stored as data, then RE-RUN
      through the same sandboxed `PtcRunner.Lisp.run/2` the `execute` tool uses,
      with the call's args bound as `data/<param>`.

  The meta-tools (`define-tool`, `define-config`, `list-tools`) are themselves
  native entries, so the agent invokes them as ordinary `(tool/define-tool …)`
  calls from inside a program.

  ## Why stored source, not a captured closure

  A defined tool is code-as-data: durable, diffable, inspectable, and re-runnable
  — the W4 "stored program" vision. Storing an Elixir closure would lose all of
  that and couldn't be shown back to the agent via `list-tools`. The cost is one
  parse + sandboxed run per invocation, which is exactly the `execute` path's
  cost and carries all its safety machinery (heap caps, tool-call limits).
  """

  alias SpellAgent.{Config, ToolRegistry}

  @doc """
  Build the name → `(args -> value)` map for SubAgent, from the registry plus
  the always-present meta-tools.
  """
  @spec build_tools_map() :: %{optional(String.t()) => (map() -> term())}
  def build_tools_map do
    # A registry (define-tool) entry must NEVER shadow a reserved native tool —
    # otherwise a stored/rehydrated durable tool named e.g. `code-edit` would win
    # (registry merges last) and bypass the parse-gated writer. Drop reserved
    # names from the registry projection so the native built-in always resolves.
    registry_tools =
      ToolRegistry.all()
      |> Enum.reject(fn entry -> reserved_name?(entry.name) end)
      |> Map.new(fn entry -> {entry.name, to_callable(entry)} end)

    # FEAT-035: the static namespaces (meta, native, freeform) come from the ONE
    # catalog. harness/keymap declare inventory metadata but build an empty map
    # here (they are built per-render by the TUI app, closing over the live
    # forest/gaze), so they don't pollute the base session map.
    SpellAgent.Namespace.static_tools_map(SpellAgent.Namespace.Catalog.specs())
    |> Map.merge(registry_tools)
  end

  # Built-in native tools that are not meta-tools (define-*) and not part of the
  # freeform render surface. `sh` runs an argv vector on brush (PLAN-011 W1).
  # Public so `SpellAgent.Namespace.Catalog` can declare this namespace's callable
  # map from ONE place (FEAT-035).
  @doc false
  def native_tools do
    %{
      "sh" => &SpellAgent.Sh.tool/1,
      "sh-pipe" => &SpellAgent.Sh.pipe_tool/1,
      "sh-parse" => &SpellAgent.Sh.parse_tool/1,
      "sh-unparse" => &SpellAgent.Sh.unparse_tool/1,
      "code-parse" => &SpellAgent.Code.parse_tool/1,
      "code-unparse" => &SpellAgent.Code.unparse_tool/1,
      "code-edit" => &SpellAgent.Code.edit_tool/1,
      "code-apply" => &SpellAgent.Code.apply_tool/1,
      # FEAT-042: symbol-aware navigation + structural edit backed by the Rust
      # kernel NIF (bounded + panic-safe in SpellAgent.Find). `edit` attributes to
      # no session ("") at the base surface — the cross-runtime broker treats it as
      # an anonymous transaction, same as a fresh CLI edit.
      "find" => &SpellAgent.Find.find_tool/1,
      "find-edges" => &SpellAgent.Find.find_edges_tool/1,
      "edit" => &SpellAgent.Find.edit_tool/1
    }
    |> Map.merge(SpellAgent.Loop.verbs())
  end

  # The freeform render-mirror surface (PLAN-009): view/ builders, theme/ palette,
  # layout/ slot ops, and lens/ tree traversals. Registered as ordinary tool-map
  # entries (the ptc_runner PATCH-O namespaces route ns/verb to these qualified
  # names). lens/ closes over the LIVE layout tree so a traversal called with `{}`
  # acts on the current UI. Degrades to no freeform tools if the registries aren't
  # running (e.g. a bare unit test), so the agent surface never crashes to build.
  @doc false
  def freeform_tools do
    SpellAgent.Tui.View.tools()
    |> Map.merge(SpellAgent.Tui.LayoutRegistry.tools())
    |> Map.merge(SpellAgent.Tui.Lens.tools(SpellAgent.Tui.LayoutRegistry.tree()))
    |> Map.merge(SpellAgent.Tui.Cell.Verb.tools())
    |> Map.merge(SpellAgent.Tui.DataSource.Verb.tools())
    |> Map.merge(SpellAgent.Tui.Human.tools())
    |> Map.merge(SpellAgent.Tui.RenderProbe.tools())
    |> Map.merge(SpellAgent.Tui.SelfView.tools())
  rescue
    _ -> %{}
  catch
    :exit, _ -> %{}
  end

  @doc """
  Tool inventory as data (for `list-tools` and for rendering the system prompt):
  a list of `%{"name","params","doc","kind"}` maps, meta-tools first.
  """
  @spec inventory() :: [map()]
  def inventory do
    # FEAT-035: the built-in surface (meta, native, hist, black, clock, spawn,
    # mesh, harness, freeform) is DERIVED from the ONE catalog — no hand-
    # maintained mirror. Runtime define-tool entries are appended.
    catalog = SpellAgent.Namespace.inventory(SpellAgent.Namespace.Catalog.specs())

    defined =
      ToolRegistry.all()
      |> Enum.map(fn e ->
        %{
          # Display in the form the agent types it: a runtime-defined tool is
          # `tool/`-routed (called `(tool/<name> …)`), same as the native surface.
          "name" => "tool/" <> e.name,
          "params" => Enum.map(Map.get(e, :params, []), &to_string/1),
          "doc" => Map.get(e, :doc, ""),
          "kind" => to_string(e.kind)
        }
      end)

    catalog ++ defined
  end

  # --- meta-tools (native) ---------------------------------------------------

  @doc false
  def meta_tools do
    %{
      "define-tool" => &define_tool/1,
      "define-config" => &define_config/1,
      "list-tools" => fn _args -> inventory() end
    }
  end

  @doc """
  `(tool/define-tool {:name "x" :params [:a :b] :doc "…" :source "<ptc>"})`.

  Validates the PTC source parses, then registers it. Returns a small data map
  the agent can read back; raises with a clear message on a bad definition (the
  `invoke_tool` contract turns the raise into an LLM-facing error payload).
  """
  @spec define_tool(map()) :: map()
  def define_tool(args) do
    name = require_string(args, "name")
    source = require_string(args, "source")
    # BUG-027 (3): reject reserved/illegal param names at DEFINE time (they would
    # otherwise fail at data/<param> bind time on first call).
    params = args |> flex_get("params") |> normalize_params()
    doc = args |> flex_get("doc") |> to_doc()

    if reserved_name?(name) do
      raise ArgumentError, "cannot redefine reserved tool #{inspect(name)}"
    end

    # BUG-027 (4): a tool named `proxy_<x>` collides with the wire tool-prefix the
    # subscription adapter strips (anthropic.ex apply/strip_tool_prefix), so it
    # could shadow or be shadowed by a prefixed native. Reject at define time.
    if String.starts_with?(name, "proxy_") do
      raise ArgumentError,
            "tool name #{inspect(name)} is reserved: the `proxy_` prefix collides with the " <>
              "wire tool-prefix; choose a name without that prefix"
    end

    # BUG-027 (2): reject an UNRECOGNIZED scope instead of silently degrading to
    # :session (a typo like "permannet" must not quietly lose durability).
    scope = strict_scope(flex_get(args, "scope"))

    # BUG-027 (1): closed-world callee check. Parse the body and reject if it calls
    # a tool name that is not (and cannot become) callable, so a typo'd callee
    # fails HERE, not three turns later on first invocation.
    with :ok <- validate_source(source),
         :ok <- check_callees(name, source) do
      ToolRegistry.put(%{
        kind: :ptc,
        name: name,
        params: params,
        doc: doc,
        source: source,
        scope: scope
      })

      %{
        "ok" => true,
        "defined" => name,
        "params" => Enum.map(params, &to_string/1),
        "scope" => to_string(scope)
      }
    else
      {:error, {:source, reason}} ->
        raise ArgumentError, "define-tool #{inspect(name)} has invalid PTC source: #{reason}"

      {:error, {:callees, unknown}} ->
        raise ArgumentError,
              "define-tool #{inspect(name)} calls unknown tool(s): " <>
                "#{Enum.map_join(unknown, ", ", &inspect/1)}. " <>
                "Define them first, or fix the name."
    end
  end

  @doc """
  `(tool/define-config {:key "model" :value "…"})` — set a live config cell.
  """
  @spec define_config(map()) :: map()
  def define_config(args) do
    key = require_string(args, "key")
    value = flex_get(args, "value")

    case Config.put(key, value) do
      :ok -> %{"ok" => true, "set" => key, "value" => value}
      {:error, reason} -> raise ArgumentError, "define-config rejected #{inspect(key)}: #{reason}"
    end
  end

  # --- entry → callable ------------------------------------------------------

  # A :native entry already carries its fn. A :ptc entry becomes a closure that
  # runs the stored source with the call args bound as data/<param>.
  defp to_callable(%{kind: :native, fun: fun}), do: fun

  defp to_callable(%{kind: :ptc, name: name, source: source}) do
    fn args ->
      context = stringify_keys(args)

      case PtcRunner.Lisp.run(source,
             context: context,
             tools: build_tools_map(),
             # PLAN-020 W7: attach the q/* prelude so an authored/durable codemod
             # tool can call q/update, q/apply-ops, etc. (same surface the main
             # loop gets). nil when compilation failed -> tool runs without q/*.
             prelude: SpellAgent.Code.Prelude.compiled(),
             caller: :in_process_v1
           ) do
        {:ok, step} ->
          step.return

        {:error, step} ->
          # Surface the program failure as a raise so invoke_tool renders an
          # LLM-facing error payload (consistent with native tool failures).
          raise "defined tool #{inspect(name)} failed: #{inspect(step.fail || step.return)}"
      end
    end
  end

  # --- validation + helpers --------------------------------------------------

  # Reject malformed definitions at define time (not at first call).
  defp validate_source(source) do
    # Use the runner's own bounded validator: parse + analyze + undefined-var
    # check, all under a heap/timeout cap. `data/<param>` references are a
    # recognized special form, not free vars, so a tool body that reads its
    # params validates cleanly. Returns :ok | {:error, [messages]}.
    # Validate WITH the q/* prelude attached so a codemod tool that calls
    # q/update / q/apply-ops validates (the analyzer knows the `q/` namespace),
    # mirroring how `to_callable` runs the tool with the prelude (PLAN-020 W7).
    case PtcRunner.Lisp.validate(source, prelude: SpellAgent.Code.Prelude.compiled()) do
      :ok -> :ok
      {:error, messages} -> {:error, {:source, Enum.join(List.wrap(messages), "; ")}}
    end
  end

  # BUG-027 (1): closed-world callee check. Collect the tool names the body calls
  # and reject any that is not in the known callable universe. Conservative to
  # avoid false positives:
  #   * BARE names (no `/`) are the typo-prone `tool/<name>` calls — checked
  #     against the base tools map + every catalog verb + registry names + the
  #     tool being defined itself (self-recursion is legal).
  #   * NAMESPACED names (`ns/verb`) are allowed as long as `ns` is a KNOWN
  #     namespace prefix (session verbs like `hist/x` aren't in the base map but
  #     are valid; `q/x` is a prelude export). An unknown PREFIX is still a typo
  #     and is rejected.
  # If the source can't even be analyzed, `validate_source` already rejected it;
  # `referenced_tools` returning an error here degrades to :ok (don't double-fail).
  defp check_callees(defining_name, source) do
    case PtcRunner.Lisp.referenced_tools(source, prelude: SpellAgent.Code.Prelude.compiled()) do
      {:ok, refs} ->
        # The EXACT callable universe: every base-map key + every catalog verb
        # (session verbs like `hist/reduce`/`black/post`/`spawn-session` that
        # aren't in the base map) + every registered runtime tool name (which may
        # itself contain a `/`, e.g. `pkg/foo`) + the tool being defined (self-
        # recursion is legal).
        known = known_callable_names() |> MapSet.put(defining_name)

        unknown =
          refs
          |> Enum.reject(fn ref ->
            # 1. Exact match against a known callable key (bare OR slash-named).
            #    This admits a registered `pkg/foo` and rejects `harness/typo`.
            # 2. Else admit ONLY if the prefix is an OPEN namespace whose member
            #    set is unbounded/reflected (view/theme/lens/layout/cell) or the
            #    prelude (q/) — there we cannot enumerate, so a prefix match is the
            #    best available check. A FIXED namespace (harness/keymap/black/
            #    hist/clock) is fully enumerated by the catalog, so an unknown
            #    member there is a typo and is rejected.
            MapSet.member?(known, ref) or open_namespace_member?(ref)
          end)
          |> Enum.sort()

        if unknown == [], do: :ok, else: {:error, {:callees, unknown}}

      {:error, _messages} ->
        # Unanalyzable source is the source-validator's job to reject; don't
        # double-report here.
        :ok
    end
  end

  # The EXACT set of callable names a defined tool may call: the assembled base
  # tools map (native + freeform + registry) plus every catalog-declared verb key
  # (so session verbs like `spawn-session`, `hist/reduce`, `black/post` are known
  # even though they aren't in the base map). Names are the exact tools-map keys
  # (bare or slash-qualified), NOT the inventory display form.
  defp known_callable_names do
    base = build_tools_map() |> Map.keys() |> MapSet.new()
    catalog = SpellAgent.Namespace.verb_names(SpellAgent.Namespace.Catalog.specs())
    MapSet.union(base, catalog)
  end

  # OPEN namespaces have an unbounded/reflected member set we cannot enumerate
  # (view/* is one verb per ex_ratatui widget; q/* is a prelude surface), so a
  # `prefix/verb` callee under one of these is admitted on the PREFIX alone. A
  # FIXED namespace (harness/keymap/black/hist/clock) is fully enumerated by the
  # catalog and therefore checked by EXACT name, so a typo'd member is rejected.
  @open_namespaces MapSet.new(["view", "theme", "lens", "layout", "cell", "data-source", "human"])

  defp open_namespace_member?(ref) do
    case String.split(ref, "/", parts: 2) do
      [prefix, _member] ->
        MapSet.member?(@open_namespaces, prefix) or MapSet.member?(prelude_namespaces(), prefix)

      _ ->
        false
    end
  end

  defp prelude_namespaces do
    case SpellAgent.Code.Prelude.compiled() do
      %PtcRunner.Lisp.Prelude{namespaces: ns} -> MapSet.new(ns)
      _ -> MapSet.new()
    end
  end

  defp reserved_name?(name),
    do:
      name in [
        "define-tool",
        "define-config",
        "list-tools",
        "sh",
        "sh-pipe",
        "sh-parse",
        "sh-unparse",
        "spawn-session",
        "await-session",
        # code-edit / code-apply are parse-GATED safety seams; a runtime
        # define-tool must not be able to shadow one (registry tools merge last)
        # and bypass the gate.
        "code-parse",
        "code-unparse",
        "code-edit",
        "code-apply",
        # FEAT-042: find/edit are native NIF-backed tools; a define-tool must not
        # shadow the structural-edit or navigation surface.
        "find",
        "find-edges",
        "edit",
        # FEAT-045: the A4 self-continuation signal.
        "loop/continue"
      ]

  defp require_string(args, key) do
    case flex_get(args, key) do
      s when is_binary(s) and s != "" -> s
      other -> raise ArgumentError, "#{key} must be a non-empty string, got #{inspect(other)}"
    end
  end

  defp normalize_params(nil), do: []
  defp normalize_params(list) when is_list(list), do: Enum.map(list, &param_name/1)

  defp normalize_params(other),
    do: raise(ArgumentError, "params must be a list, got #{inspect(other)}")

  # PTC special-form / control names that would collide with a `data/<param>`
  # binding or a reserved sigil. A param with one of these names normalizes fine
  # but fails (or silently misbehaves) at bind time, so reject at define time.
  @reserved_params ~w(return fail do fn def let if cond case when and or not)

  # A param name is validated and kept as a STRING. It is metadata only (docs +
  # `list-tools` display); the actual `data/<param>` binding at call time comes
  # from the call's ARGS, not this list. So we MUST NOT `String.to_atom/1` a
  # user-controlled param name — that permanently grows the BEAM atom table and,
  # with enough unique define-tool param names, exhausts the VM (an atom-table
  # DoS, review S1 P1). Strings carry the same information without the hazard.
  defp param_name(p) when is_atom(p), do: p |> Atom.to_string() |> param_name()

  defp param_name(p) when is_binary(p) do
    cond do
      p == "" ->
        raise ArgumentError, "param name must be a non-empty string"

      p in @reserved_params ->
        raise ArgumentError,
              "param name #{inspect(p)} is reserved (a PTC special form); choose another name"

      not Regex.match?(~r/^[a-z][a-z0-9_-]*$/i, p) ->
        raise ArgumentError,
              "param name #{inspect(p)} is not a valid identifier " <>
                "(letters, digits, _ and - only, starting with a letter)"

      true ->
        p
    end
  end

  defp param_name(p),
    do: raise(ArgumentError, "param must be an atom or string, got #{inspect(p)}")

  defp to_doc(nil), do: ""
  defp to_doc(d) when is_binary(d), do: d
  defp to_doc(d), do: to_string(d)

  # Tool persistence scope (PLAN-011 W3). Default `:session` (in-memory, gone on
  # restart); `:durable` mirrors the tool to the history store so it survives.
  # Case-insensitive on strings/atoms so "Durable"/"DURABLE"/:Durable/"true" all
  # resolve to :durable — the agent should never silently lose persistence to a
  # casing variant. `define-tool` echoes the resolved scope so the agent can
  # confirm what it got.
  # BUG-027 (2): STRICT scope resolution. An ABSENT scope defaults to :session
  # (in-memory), but an explicitly-PROVIDED-but-unrecognized value (e.g. a typo'd
  # "permannet") is REJECTED rather than silently degraded — the agent must never
  # quietly lose durability to a casing/spelling variant.
  defp strict_scope(nil), do: :session

  defp strict_scope(value) when is_atom(value) do
    strict_scope(Atom.to_string(value))
  end

  defp strict_scope(value) when is_binary(value) do
    case String.downcase(String.trim(value)) do
      "durable" -> :durable
      "true" -> :durable
      "session" -> :session
      "false" -> :session
      other ->
        raise ArgumentError,
              "unrecognized scope #{inspect(other)}; expected \"durable\" or \"session\""
    end
  end

  defp strict_scope(other),
    do: raise(ArgumentError, "scope must be a string (\"durable\"/\"session\"), got #{inspect(other)}")

  # Args arrive with string OR atom keys (and LispKeyword-derived atoms);
  # tolerate both, normalizing to string lookups.
  defp flex_get(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, safe_atom(key))
  end

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {to_string(k), v} end)
  end

  defp stringify_keys(other), do: other
end
