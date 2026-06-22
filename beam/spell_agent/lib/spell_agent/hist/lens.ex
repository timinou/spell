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
        "form_tree"  => map() | nil,              # the program as a PTC-native tree (FUP-002)
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
    "provenance" => "provenance.ptc",
    "form_tree" => "form_tree.ptc"
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
      # PLAN-011 W6: shell-command HEADS the program runs (rg, git, …) extracted
      # from `(tool/sh {:argv …})` / `(tool/sh-pipe {:stages …})` literals. The
      # shell analogue of `form_tools`: lets `hist/forms {:shell "rg"}` recall
      # turns by command, matching `{:tool "edit"}` for Lisp calls.
      "form_shells" => shell_heads(n.form),
      "defs" => def_names(n.form),
      # FUP-001: `introduced` = names this turn FIRST bound; `bound` = ALL names
      # in its delta (introduced + rebinds). A provenance lens reads `introduced`
      # to find first-definition and `bound` to find rebinds, with no env fold.
      "introduced" => Enum.map(n.introduced, &to_string/1),
      "bound" => n.binds |> Map.keys() |> Enum.map(&to_string/1),
      # FUP-002: the program AS A WALKABLE TREE (PTC-native, no tuples). Lets a
      # lens ask structural questions of past programs ("tool calls inside a
      # let", "defs whose value is a fn") without an Elixir change per question.
      "form_tree" => form_tree(n.form),
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

  @doc """
  Project a CoreAST `form` into a PTC-NATIVE nested tree (FUP-002).

  The executed AST (`Node.form`, MOVE-C) is an Elixir tuple shape — `{:def, name,
  val, meta}`, `{:tool_call, name, args}`, `{:call, {:var, n}, args}`, `{:var,
  n}`, `{:literal, v}`, and the compound forms (`:do`/`:let`/`:if`/`:fn`/...).
  PTC has NO tuple type, so the tree is projected to JSON-able maps a sandboxed
  lens can walk:

      {:def, "x", {:literal, 1}}
        => %{"node" => "def", "name" => "x",
             "children" => [%{"node" => "literal", "value" => 1}]}

  Leaves carry their datum: a `:var` its `"name"`, a `:literal`/`:quoted_symbol`
  its `"value"`. Every other node is generic `%{"node" => kind, "children" =>
  [...]}` — so an UPSTREAM AST RESHAPE still projects (unknown kinds included),
  it never crashes a lens. The output contains NO tuples (the PTC-safety contract).
  A non-AST `form` (a synthetic turn's source string, or nil) projects to nil.
  """
  @spec form_tree(term()) :: map() | nil
  def form_tree({:var, name}), do: %{"node" => "var", "name" => name_str(name)}
  def form_tree({:literal, value}), do: %{"node" => "literal", "value" => jsonable(value)}

  def form_tree({:quoted_symbol, name}),
    do: %{"node" => "quoted_symbol", "value" => name_str(name)}

  def form_tree({:def, name, value, _meta}),
    do: %{"node" => "def", "name" => name_str(name), "children" => [form_tree(value)]}

  def form_tree({:tool_call, name, args}),
    do: %{"node" => "tool_call", "name" => name_str(name), "children" => child_trees(args)}

  def form_tree({:call, {:var, name}, args}),
    do: %{"node" => "call", "name" => name_str(name), "children" => child_trees(args)}

  # Generic AST node: a tagged tuple whose head is the kind. Drift-resilient — a
  # node kind this projector has never seen still becomes a walkable subtree.
  def form_tree(node) when is_tuple(node) and tuple_size(node) > 0 do
    [kind | rest] = Tuple.to_list(node)
    %{"node" => name_str(kind), "children" => child_trees(rest)}
  end

  def form_tree(list) when is_list(list), do: %{"node" => "seq", "children" => child_trees(list)}
  def form_tree(_other), do: nil

  # Project a list of child forms, dropping the nils (metadata maps, empty slots)
  # so the tree carries only real structural children.
  defp child_trees(args) when is_list(args),
    do: args |> Enum.map(&form_tree/1) |> Enum.reject(&is_nil/1)

  defp child_trees(other), do: other |> List.wrap() |> child_trees()

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

  @doc """
  Shell-command heads invoked by a turn's program (PLAN-011 W6).

  Where `form_tools` records the TOOL name (`"sh"`, `"sh-pipe"`), this records
  the COMMAND head a shell call runs — `rg`, `head`, `git` — by reading the
  `:argv` (for `sh`) or `:stages` (for `sh-pipe`) literal in the call. It lets
  `hist/forms {:shell "rg"}` find turns that ran a specific command, the shell
  analogue of `{:tool "edit"}` (docs/shell-as-data.md §5). Only LITERAL heads are
  captured; a computed argv (`~expr` in head position) is not statically known
  and is skipped.
  """
  @spec shell_heads(term()) :: [String.t()]
  def shell_heads(form), do: form |> collect_shells([]) |> Enum.reverse() |> Enum.uniq()

  # (tool/sh {:argv ["rg" …]}) -> "rg"
  defp collect_shells({:tool_call, "sh", args}, acc),
    do: collect_shells(args, prepend_head(argv_head(args), acc))

  # (tool/sh-pipe {:stages [["cat" …] ["grep" …]]}) -> "cat", "grep"
  defp collect_shells({:tool_call, "sh-pipe", args}, acc),
    do: collect_shells(args, prepend_heads(stages_heads(args), acc))

  defp collect_shells(form, acc) when is_tuple(form),
    do: form |> Tuple.to_list() |> Enum.reduce(acc, &collect_shells/2)

  defp collect_shells(form, acc) when is_list(form),
    do: Enum.reduce(form, acc, &collect_shells/2)

  defp collect_shells(form, acc) when is_map(form),
    do: Enum.reduce(form, acc, fn {_k, v}, a -> collect_shells(v, a) end)

  defp collect_shells(_form, acc), do: acc

  defp prepend_head(nil, acc), do: acc
  defp prepend_head(head, acc), do: [head | acc]

  defp prepend_heads(heads, acc), do: Enum.reduce(heads, acc, &[&1 | &2])

  # Extract the literal head of an `:argv` vector from a tool-call's args.
  defp argv_head(args) do
    case find_map_value(args, "argv") do
      {:vector, [{:string, head} | _]} -> head
      _ -> nil
    end
  end

  # Extract the literal heads of each stage in a `:stages` vector.
  defp stages_heads(args) do
    case find_map_value(args, "stages") do
      {:vector, stages} ->
        stages
        |> Enum.map(fn
          {:vector, [{:string, head} | _]} -> head
          _ -> nil
        end)
        |> Enum.reject(&is_nil/1)

      _ ->
        []
    end
  end

  # Find the value bound to `key` in the first `{:map, pairs}` of a call's args.
  defp find_map_value(args, key) when is_list(args) do
    Enum.find_value(args, fn
      {:map, pairs} -> map_pair_value(pairs, key)
      _ -> nil
    end)
  end

  defp find_map_value(_args, _key), do: nil

  defp map_pair_value(pairs, key) do
    Enum.find_value(pairs, fn
      {{:keyword, ^key}, value} -> value
      _ -> nil
    end)
  end

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
