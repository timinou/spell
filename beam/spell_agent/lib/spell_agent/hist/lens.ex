defmodule SpellAgent.Hist.Lens do
  @moduledoc """
  The Elixir half of the homoiconic query layer (PLAN-005, FUP-PTC-LENSES).

  The decision in PLAN-004 splits Hist along one line: **Elixir owns primitives +
  invariants; PTC owns policies + lenses.** A *lens* — "which turns called
  `tool/edit`?", "how many tokens did I spend?" — is a PURE transform over node
  data, exactly the thing the agent might want to reshape at runtime. So a lens is
  written as PTC-Lisp source, and this module is the thin Elixir primitive beneath
  it that does the two things the sandbox cannot:

    1. **Materialize + project** the session's nodes into plain, string-keyed,
       JSON-serializable maps (`project/3`). The PTC-Lisp AST in `Node.form` is an
       Elixir tuple — not a sandbox value — so the structural facts a lens needs
       (which tools were called, which symbols were defined) are pre-extracted
       here into `"tool_calls"` and `"defs"` fields.
    2. **Run** a lens program over that projection (`run/4`), injecting it as the
       `data/nodes` context and the caller's args as `data/<key>`, through the same
       `PtcRunner.Lisp.run/2` sandbox the `execute` tool uses — heap caps, tool-call
       limits, and large-value handle-parking all included.

  This is "Elixir materializes, PTC transforms": the heavy/stateful/invariant work
  stays compiled; the interpretation ships as data the agent can read, copy, edit,
  and re-run with zero Elixir deploy. A bad lens yields a wrong query result, never
  a corrupt store — every write still goes through validated Elixir verbs.

  ## The projection contract

  `project/3` returns, ordered by `seq`, one map per node:

      %{
        "id"         => String.t(),
        "seq"        => non_neg_integer(),
        "status"     => "ok" | "error",          # node-level status
        "form_src"   => String.t() | nil,         # the rendered program
        "tool_calls" => [%{"name","args","result","status"}],  # realized sees
        "defs"       => [String.t()],             # symbols defined in the form AST
        "introduced" => [String.t()],             # names this turn FIRST bound (FUP-001)
        "bound"      => [String.t()],             # ALL names in the turn's delta (FUP-001)
        "tokens"     => %{"input" => int, "output" => int}
      }

  Every value is string-keyed and JSON-round-trippable — the stable interface a
  lens sees. The AST never crosses into the sandbox.
  """

  alias SpellAgent.Hist.{Node, Result, Store}

  @typedoc "A projected node — string-keyed, JSON-serializable."
  @type projected :: %{required(String.t()) => term()}

  # The default lens library, loaded from priv at compile time. Each entry maps a
  # `hist/*` verb name to its PTC-Lisp source. `@external_resource` makes a change
  # to a `.ptc` file recompile this module. These ship as DATA, so the same source
  # the agent runs is the source it can read back and fork (runtime authorship).
  @lens_dir Path.join([:code.priv_dir(:spell_agent) |> to_string(), "hist", "lenses"])

  @lenses %{
    "forms" => "forms.ptc",
    "defs" => "defs.ptc",
    "tool_calls" => "tool_calls.ptc",
    "cost" => "cost.ptc",
    "provenance" => "provenance.ptc"
  }

  for {_name, file} <- @lenses do
    @external_resource Path.join(@lens_dir, file)
  end

  @lens_sources (for {name, file} <- @lenses, into: %{} do
                   {name, File.read!(Path.join(@lens_dir, file))}
                 end)

  @doc "The default lens library: verb name (no `hist/` prefix) => PTC-Lisp source."
  @spec sources() :: %{optional(String.t()) => String.t()}
  def sources, do: @lens_sources

  @doc """
  The `hist/*` lens verbs for a session, as a tool map to merge into the agent's
  tools (and into `Hist.Namespace`). Each verb runs its default PTC-Lisp lens over
  the session's projection via `run/4`, closing over `impl` + `session_id`.

  Also exposes `hist/lens` — the runtime-authorship surface: it runs an ARBITRARY
  lens `source` (from `args["source"]`) over the same projection, so the agent can
  author and run a novel lens with zero Elixir deploy.
  """
  @spec tools(module(), String.t()) :: %{optional(String.t()) => (map() -> term())}
  def tools(impl, session_id) do
    default =
      Map.new(@lens_sources, fn {name, source} ->
        {"hist/" <> name, fn args -> run(impl, session_id, source, args || %{}) end}
      end)

    Map.put(default, "hist/lens", fn args ->
      case (args || %{})["source"] do
        src when is_binary(src) -> run(impl, session_id, src, Map.delete(args, "source"))
        _ -> %{"err" => "hist/lens requires a string :source"}
      end
    end)
  end

  @doc """
  Project a session's nodes to the lens data contract (see moduledoc), ordered by
  `seq`. `:since_seq` keeps only nodes with `seq >= n`.
  """
  @spec project(module(), String.t(), keyword()) :: [projected()]
  def project(impl, session_id, opts \\ []) do
    since = Keyword.get(opts, :since_seq)

    Store.list(impl, :node, session_id)
    |> Enum.sort_by(& &1.seq)
    |> Enum.filter(fn %Node{seq: seq} -> is_nil(since) or seq >= since end)
    |> Enum.map(&project_node/1)
  end

  @doc """
  Run a lens program over a session's projection.

  The projection is injected as `data/nodes`; each key of `args` (string-keyed) is
  injected as `data/<key>` so a lens can parameterize (e.g. `data/tool`). Returns
  the program's `step.return`, or `{:error, reason}` if the lens fails to run —
  a lens NEVER raises into the caller (a bad lens is a bad query, not a crash).

  `:tools` may pass a tool map if a lens calls tools; by default a lens is pure and
  gets none, which keeps authored lenses sandboxed to data transforms.
  """
  @spec run(module(), String.t(), String.t(), map()) :: term() | {:error, term()}
  def run(impl, session_id, lens_source, args \\ %{}) when is_binary(lens_source) do
    nodes = project(impl, session_id, project_opts(impl, session_id, args))
    context = args |> stringify_keys() |> Map.put("nodes", nodes)

    case PtcRunner.Lisp.run(lens_source,
           context: context,
           filter_context: false,
           caller: :in_process_v1
         ) do
      {:ok, step} -> step.return
      {:error, step} -> {:error, step.fail || step.return || :lens_failed}
    end
  end

  # --- projection ---

  defp project_node(%Node{} = n) do
    %{
      "id" => n.id,
      "seq" => n.seq,
      "status" => Atom.to_string(n.status),
      "form_src" => n.form_src,
      # `tool_calls` = REALIZED effects (from `sees`); `form_tools` = tool-call
      # names present in the program AST. They differ (a call can be in the form
      # but error before emitting a see), so the `tool_calls` lens reads the former
      # and the `forms` lens reads the latter — matching Query.tool_calls vs
      # Query.forms exactly.
      "tool_calls" => project_tool_calls(n.sees),
      "form_tools" => tool_call_names(n.form),
      "defs" => def_names(n.form),
      # FUP-001: `introduced` = names this turn FIRST bound; `bound` = ALL names
      # in its delta (introduced + rebinds). A provenance lens reads `introduced`
      # to find first-definition and `bound` to find rebinds, with no env fold.
      "introduced" => Enum.map(n.introduced, &to_string/1),
      "bound" => n.binds |> Map.keys() |> Enum.map(&to_string/1),
      # `has_tokens` mirrors Query.cost's count rule: only nodes with a valid
      # integer token map are counted. A default {0,0} would be indistinguishable
      # from a real zero, so the flag preserves nodes_counted parity.
      "has_tokens" => valid_tokens?(n.tokens),
      "tokens" => project_tokens(n.tokens)
    }
  end

  defp project_tool_calls(sees) when is_list(sees) do
    Enum.map(sees, fn see ->
      result = mixed_get(see, :result)

      %{
        "name" => to_string(mixed_get(see, :name) || ""),
        "args" => jsonable(mixed_get(see, :args)),
        # presence-aware: a real `false`/`nil` tool result must survive (a `||`
        # fallback would silently turn `false` into a missing value).
        "result" => jsonable(result),
        "status" => Atom.to_string(Result.status(result))
      }
    end)
  end

  defp project_tool_calls(_), do: []

  defp project_tokens(%{input: i, output: o}) when is_integer(i) and is_integer(o),
    do: %{"input" => i, "output" => o}

  defp project_tokens(%{"input" => i, "output" => o}) when is_integer(i) and is_integer(o),
    do: %{"input" => i, "output" => o}

  defp project_tokens(_), do: %{"input" => 0, "output" => 0}

  # Extract every symbol defined by a `(def name ...)` anywhere in the form AST,
  # as strings. The CoreToSource AST uses `{:def, name, value, meta}`; names may be
  # atoms or strings. This mirrors `Query.contains_def?` traversal but COLLECTS
  # names rather than testing one, because PTC cannot walk the Elixir tuple itself.
  @doc false
  @spec def_names(term()) :: [String.t()]
  def def_names(form), do: form |> collect_defs([]) |> Enum.reverse() |> Enum.uniq()

  defp collect_defs({:def, name, value, _meta}, acc),
    do: collect_defs(value, [name_str(name) | acc])

  defp collect_defs(form, acc) when is_tuple(form),
    do: form |> Tuple.to_list() |> Enum.reduce(acc, &collect_defs/2)

  defp collect_defs(form, acc) when is_list(form),
    do: Enum.reduce(form, acc, &collect_defs/2)

  defp collect_defs(form, acc) when is_map(form),
    do: Enum.reduce(form, acc, fn {_k, v}, a -> collect_defs(v, a) end)

  defp collect_defs(_form, acc), do: acc

  defp name_str(n) when is_atom(n), do: Atom.to_string(n)
  defp name_str(n) when is_binary(n), do: n
  defp name_str(n), do: inspect(n)

  # Collect every tool-call NAME present in the form AST (`{:tool_call, name, _}`),
  # as strings. The form-AST analogue of `def_names/1`; the basis of the `forms`
  # lens, mirroring `Query.contains_tool_call?` traversal but collecting names.
  @doc false
  @spec tool_call_names(term()) :: [String.t()]
  def tool_call_names(form), do: form |> collect_calls([]) |> Enum.reverse() |> Enum.uniq()

  defp collect_calls({:tool_call, name, args}, acc),
    do: collect_calls(args, [name_str(name) | acc])

  defp collect_calls(form, acc) when is_tuple(form),
    do: form |> Tuple.to_list() |> Enum.reduce(acc, &collect_calls/2)

  defp collect_calls(form, acc) when is_list(form),
    do: Enum.reduce(form, acc, &collect_calls/2)

  defp collect_calls(form, acc) when is_map(form),
    do: Enum.reduce(form, acc, fn {_k, v}, a -> collect_calls(v, a) end)

  defp collect_calls(_form, acc), do: acc

  defp valid_tokens?(%{input: i, output: o}) when is_integer(i) and is_integer(o), do: true

  defp valid_tokens?(%{"input" => i, "output" => o}) when is_integer(i) and is_integer(o),
    do: true

  defp valid_tokens?(_), do: false

  # --- helpers ---

  # Resolve projection-scoping args in Elixir (a lens only ever sees data/nodes).
  # `since_seq` scopes directly; `since_mark` mirrors Query.cost — a mark id is
  # resolved to its node's seq via the store, so hist/cost honors a bookmark exactly
  # like the Elixir fast path.
  defp project_opts(impl, session_id, args) do
    cond do
      is_integer(args["since_seq"] || args[:since_seq]) ->
        [since_seq: args["since_seq"] || args[:since_seq]]

      mark = args["since_mark"] || args[:since_mark] ->
        case mark_seq(impl, session_id, mark) do
          n when is_integer(n) -> [since_seq: n]
          _ -> []
        end

      true ->
        []
    end
  end

  # The seq of a mark's node (nil if the mark or its node is absent) — the same
  # resolution Query.cost uses for :since_mark.
  defp mark_seq(impl, session_id, mark_id) do
    with {:ok, %{node_id: node_id}} <- Store.fetch(impl, {:mark, session_id, mark_id}),
         {:ok, %Node{seq: seq}} <- Store.fetch(impl, {:node, session_id, node_id}) do
      seq
    else
      _ -> nil
    end
  end

  # Fetch a key that may be atom- or string-keyed, returning nil only when ABSENT
  # under both (so a stored `false`/`nil` value is preserved, not treated as missing).
  defp mixed_get(map, key) when is_map(map) do
    skey = Atom.to_string(key)

    cond do
      Map.has_key?(map, key) -> Map.get(map, key)
      Map.has_key?(map, skey) -> Map.get(map, skey)
      true -> nil
    end
  end

  defp mixed_get(_map, _key), do: nil

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {to_string(k), v} end)
  end

  # Best-effort coercion of an arbitrary term into something JSON/PTC-safe. Tuples
  # (e.g. {:error, reason}) become lists; everything else passes through. Keeps the
  # projection serializable without losing the shape a lens reasons about.
  defp jsonable(term) when is_tuple(term), do: term |> Tuple.to_list() |> Enum.map(&jsonable/1)
  defp jsonable(term) when is_list(term), do: Enum.map(term, &jsonable/1)

  defp jsonable(term) when is_map(term),
    do: Map.new(term, fn {k, v} -> {jsonable(k), jsonable(v)} end)

  defp jsonable(term) when is_atom(term) and term not in [true, false, nil],
    do: Atom.to_string(term)

  defp jsonable(term), do: term
end
