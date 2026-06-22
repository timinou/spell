defmodule SpellAgent.Hist.Query do
  @moduledoc """
  Read-only interrogation of a stored conversation (PLAN-001, C4 QUERY).

  `Query` treats history as DATA: it flattens tool invocations, walks PTC-Lisp
  ASTs structurally, locates definitions, diffs turns, and sums token spend.
  Every function is pure — it takes a `Hist.Store` impl + `session_id` and
  returns plain lists/maps — so the same queries can run against the in-memory
  store in tests, the Khepri store in production, or a future read replica.

  ## Structural matching

  PTC-Lisp forms are stored as `Node.form` AST terms. `Query` understands the
  shapes emitted by `PtcRunner.Lisp.CoreToSource`:

    * `{:tool_call, name, args}` — a `(tool/NAME {...})` invocation
    * `{:def, name, value, meta}` — a `(def name value)` binding
    * `{:call, f, args}`, `{:var, name}`, `{:do, exprs}`, literals

  `forms/3` can match with an arbitrary predicate or with the convenience tuple
  `{:tool_call, name}` to find any turn whose program contains that tool call
  anywhere in its AST tree.

  ## Use-case

  The agent asks its own log: "show me every `(tool/edit ...)` that errored",
  "where did I define `plan`?", "how many tokens since my last bookmark?".
  These questions are answered directly from the durable node graph, without
  re-executing or re-prompting a model.
  """

  alias SpellAgent.Hist.Lens
  alias SpellAgent.Hist.Node
  alias SpellAgent.Hist.Store

  @type status :: :ok | :error

  @doc """
  Every tool call recorded across the session's nodes.

  Tool calls are taken from each node's `sees` list (the realized tool effects),
  flattened, and ordered by node sequence. Options:

    * `:name` — keep only calls whose tool name equals this string
    * `:status` — keep only `:ok` or `:error` calls

  A call is `:error` if its `result` looks like an error term: a map containing
  an `"err"`, `"error"`, `:err`, or `:error` key; or a `{:error, _}` tuple.
  Otherwise it is `:ok`.

  Returns `[%{node_id: String.t(), tool: String.t(), args: term(),
  result: term(), status: status()}]`.
  """
  @spec tool_calls(module(), String.t(), keyword()) :: [map()]
  def tool_calls(impl, session_id, opts \\ []) do
    name_filter = Keyword.get(opts, :name)
    status_filter = Keyword.get(opts, :status)

    Store.list(impl, :node, session_id)
    |> Enum.sort_by(& &1.seq)
    |> Enum.flat_map(fn %Node{id: nid, seq: seq, sees: sees} ->
      Enum.map(sees, fn see ->
        %{
          node_id: nid,
          node_seq: seq,
          tool: see[:name],
          args: see[:args],
          result: see[:result],
          status: status_of_result(see[:result])
        }
      end)
    end)
    |> maybe_filter(&(&1.tool == name_filter), name_filter)
    |> maybe_filter(&(&1.status == status_filter), status_filter)
    |> Enum.map(&Map.drop(&1, [:node_seq]))
  end

  @doc """
  Return every node whose `form` matches the given matcher, ordered by seq.

  `matcher` can be:

    * a predicate function `(form -> boolean)`
    * `{:tool_call, name}` — matches any form containing `{:tool_call, name, _}`
      anywhere in its AST tree

  The public helper `contains_tool_call?/2` is used internally and exposed for
  custom predicates.
  """
  @spec forms(module(), String.t(), (term() -> boolean()) | {:tool_call, String.t()}) :: [
          Node.t()
        ]
  def forms(impl, session_id, matcher) when is_function(matcher, 1) do
    Store.list(impl, :node, session_id)
    |> Enum.filter(fn %Node{form: form} -> matcher.(form) end)
    |> Enum.sort_by(& &1.seq)
  end

  def forms(impl, session_id, {:tool_call, name}) do
    forms(impl, session_id, &contains_tool_call?(&1, name))
  end

  # PLAN-011 W6: turns whose program runs a shell command with the given HEAD
  # (rg, git, …) via (tool/sh {:argv [head …]}) or (tool/sh-pipe {:stages …}).
  def forms(impl, session_id, {:shell, head}) do
    forms(impl, session_id, fn form -> head in Lens.shell_heads(form) end)
  end

  @doc """
  True if `form` contains a `{:tool_call, name, _}` anywhere in its AST tree.
  """
  @spec contains_tool_call?(term(), String.t() | atom()) :: boolean()
  def contains_tool_call?(form, name) do
    match_tool_call(form, name)
  end

  @doc """
  Locate every node where `sym` is defined as `(def sym ...)`.

  Matches `{:def, sym_atom_or_string, _, _}` anywhere in the AST. Returns
  `[%{node_id: String.t(), seq: non_neg_integer(), form_src: String.t() | nil}]`.
  """
  @spec defq(module(), String.t(), String.t() | atom()) :: [map()]
  def defq(impl, session_id, sym) do
    Store.list(impl, :node, session_id)
    |> Enum.filter(fn %Node{form: form} -> contains_def?(form, sym) end)
    |> Enum.sort_by(& &1.seq)
    |> Enum.map(fn %Node{id: id, seq: seq, form_src: src} ->
      %{node_id: id, seq: seq, form_src: src}
    end)
  end

  @doc """
  Structural diff of two turns by sequence number.

  Fetches the nodes at `seq_a` and `seq_b`, compares their rendered source
  (`form_src`), and returns both sources plus a boolean. A full tree-diff is
  future work; this gives the agent both program texts and a quick same/different
  answer.
  """
  @spec diff(module(), String.t(), non_neg_integer(), non_neg_integer()) :: %{
          a: String.t() | nil,
          b: String.t() | nil,
          same?: boolean()
        }
  def diff(impl, session_id, seq_a, seq_b) do
    node_a = find_node_by_seq(impl, session_id, seq_a)
    node_b = find_node_by_seq(impl, session_id, seq_b)

    src_a = node_a && node_a.form_src
    src_b = node_b && node_b.form_src

    %{a: src_a, b: src_b, same?: src_a == src_b}
  end

  @doc """
  Sum token spend across the session.

  Options:

    * `:since_mark` — a mark id; only nodes at or after the marked node's seq
      are counted

  Returns `%{input: integer(), output: integer(), total: integer(),
  nodes_counted: integer()}`.
  """
  @spec cost(module(), String.t(), keyword()) :: %{
          input: integer(),
          output: integer(),
          total: integer(),
          nodes_counted: integer()
        }
  def cost(impl, session_id, opts \\ []) do
    min_seq = mark_seq(impl, session_id, opts[:since_mark])

    nodes =
      Store.list(impl, :node, session_id)
      |> Enum.filter(fn %Node{seq: seq} -> is_nil(min_seq) or seq >= min_seq end)

    Enum.reduce(nodes, %{input: 0, output: 0, total: 0, nodes_counted: 0}, fn %Node{
                                                                                tokens: tokens
                                                                              },
                                                                              acc ->
      case tokens do
        %{input: i, output: o} when is_integer(i) and is_integer(o) ->
          %{
            input: acc.input + i,
            output: acc.output + o,
            total: acc.total + i + o,
            nodes_counted: acc.nodes_counted + 1
          }

        _ ->
          acc
      end
    end)
  end

  # --- AST matching ---

  defp match_tool_call({:tool_call, name, _args}, want) when name == want, do: true

  defp match_tool_call(form, want) when is_tuple(form) do
    form
    |> Tuple.to_list()
    |> Enum.any?(&match_tool_call(&1, want))
  end

  defp match_tool_call(form, want) when is_list(form) do
    Enum.any?(form, &match_tool_call(&1, want))
  end

  defp match_tool_call(form, want) when is_map(form) do
    Enum.any?(form, fn {_k, v} -> match_tool_call(v, want) end)
  end

  defp match_tool_call(_form, _want), do: false

  # Names may be atoms (PTC-Lisp AST) or strings (tool args); compare by string
  # form so :plan matches "plan" (BUG-002). On no match, recurse the value so a
  # def nested inside another def's body is still found.
  defp contains_def?({:def, name, value, _meta}, want) do
    name_str(name) == name_str(want) or contains_def?(value, want)
  end

  defp contains_def?(form, want) when is_tuple(form) do
    form
    |> Tuple.to_list()
    |> Enum.any?(&contains_def?(&1, want))
  end

  defp contains_def?(form, want) when is_list(form) do
    Enum.any?(form, &contains_def?(&1, want))
  end

  defp contains_def?(form, want) when is_map(form) do
    Enum.any?(form, fn {_k, v} -> contains_def?(v, want) end)
  end

  defp contains_def?(_form, _want), do: false

  defp name_str(n) when is_atom(n), do: Atom.to_string(n)
  defp name_str(n) when is_binary(n), do: n
  defp name_str(n), do: inspect(n)

  # --- helpers ---

  defp status_of_result(result), do: SpellAgent.Hist.Result.status(result)

  defp maybe_filter(list, _pred, nil), do: list
  defp maybe_filter(list, pred, _value), do: Enum.filter(list, pred)

  defp find_node_by_seq(impl, session_id, seq) do
    Store.list(impl, :node, session_id)
    |> Enum.find(&(&1.seq == seq))
  end

  defp mark_seq(_impl, _session_id, nil), do: nil

  defp mark_seq(impl, session_id, mark_id) do
    case Store.fetch(impl, {:mark, session_id, mark_id}) do
      {:ok, %{node_id: node_id}} ->
        case Store.fetch(impl, {:node, session_id, node_id}) do
          {:ok, %Node{seq: seq}} -> seq
          _ -> nil
        end

      _ ->
        nil
    end
  end
end
