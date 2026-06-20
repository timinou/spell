defmodule SpellAgent.Hist.Crystallize do
  @moduledoc ~S|
    Turn a successful slice of session history into durable, reusable memory
    (PLAN-001, C2).

    A `Crystal` is a compiled PTC-Lisp program distilled from a chain of nodes
    that worked. Production calls `PtcRunner.SubAgent.compile/2` once and hands
    the resulting `%PtcRunner.SubAgent.CompiledAgent{}` to `crystallize/4` via
    the `{:compiled, compiled}` strategy. Tests and deterministic pipelines use
    `{:source, source_string}` to prove the data flow without any network LLM.

    `slice_source/3` concatenates the source of each chosen node (in `seq`
    order) into a single `(do ...)` PTC-Lisp program — the raw material for
    compilation and the default fallback source.
  |

  alias PtcRunner.SubAgent.CompiledAgent
  alias SpellAgent.Hist.{Crystal, Id, Node, Store}

  @doc ~S|
    Persist a crystal from a slice of nodes.

    `attrs` must contain `:name` and a `:compile` strategy:

      * `{:source, source_string}` — caller supplies the program directly.
      * `{:compiled, %CompiledAgent{}}` — caller supplies an already-compiled
        agent (production path).

    Returns `{:error, :empty_slice}` when `node_ids` is empty. Missing node ids
    are silently skipped when computing provenance, but the error guard fires
    first on an empty input list.
  |
  @spec crystallize(module(), String.t(), [String.t()], map()) ::
          {:ok, Crystal.t()} | {:error, :empty_slice}
  def crystallize(_impl, _sid, [], _attrs), do: {:error, :empty_slice}

  def crystallize(impl, sid, node_ids, attrs) when is_list(node_ids) do
    compile = attrs[:compile] || {:source, slice_source(impl, sid, node_ids)}

    {source, meta} = compile_info(compile, node_ids)

    crystal = %Crystal{
      id: Id.rand("crystal"),
      name: attrs[:name],
      signature: attrs[:signature],
      source: source,
      origin: %{session: sid, nodes: node_ids},
      metadata: meta,
      t: System.system_time(:millisecond)
    }

    :ok = Store.put(impl, {:crystal, crystal.id}, crystal)
    {:ok, crystal}
  end

  @doc ~S|
    Concatenate the `form_src` of the requested nodes into one PTC-Lisp program.

    Nodes are ordered by `seq`. Missing ids are skipped. The result is wrapped
    in `(do ...)` so it is a valid PTC-Lisp program.
  |
  @spec slice_source(module(), String.t(), [String.t()]) :: String.t()
  def slice_source(impl, sid, node_ids) do
    node_ids
    |> Enum.map(fn nid -> fetch_node({impl, sid, nid}) end)
    |> Enum.reject(&is_nil/1)
    |> Enum.sort_by(& &1.seq)
    |> Enum.map_join("\n  ", & &1.form_src)
    |> wrap_do()
  end

  @doc ~S|Fetch a single crystal by id.|
  @spec get(module(), String.t()) :: {:ok, Crystal.t()} | :error
  def get(impl, id) do
    Store.fetch(impl, {:crystal, id})
  end

  @doc ~S|List all crystals.|
  @spec all(module()) :: [Crystal.t()]
  def all(impl) do
    Store.list(impl, :crystal, nil)
  end

  @doc ~S|
    Return the crystal's PTC-Lisp source so it can be registered as a callable
    tool. A crystal IS a reusable PTC-Lisp program.
  |
  @spec to_tool_source(Crystal.t()) :: String.t()
  def to_tool_source(%Crystal{source: source}), do: source

  # --- internals ---

  defp fetch_node({impl, sid, nid}) do
    case Store.fetch(impl, {:node, sid, nid}) do
      {:ok, %Node{} = node} -> node
      :error -> nil
    end
  end

  defp wrap_do(""), do: "(do)"
  defp wrap_do(body), do: "(do\n  " <> body <> "\n)"

  defp compile_info({:source, source}, node_ids) do
    now = DateTime.utc_now() |> DateTime.to_iso8601()

    meta = %{
      compiled_at: now,
      tokens_used: 0,
      turns: length(node_ids),
      llm_model: nil
    }

    {source, meta}
  end

  defp compile_info({:compiled, %CompiledAgent{source: source, metadata: compiled_meta}}, node_ids) do
    compiled_at =
      case compiled_meta[:compiled_at] do
        %DateTime{} = dt -> DateTime.to_iso8601(dt)
        other when is_binary(other) -> other
        _ -> DateTime.utc_now() |> DateTime.to_iso8601()
      end

    meta = %{
      compiled_at: compiled_at,
      tokens_used: compiled_meta[:tokens_used] || 0,
      turns: compiled_meta[:turns] || length(node_ids),
      llm_model: compiled_meta[:llm_model]
    }

    {source, meta}
  end
end
