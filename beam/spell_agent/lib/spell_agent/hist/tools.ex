defmodule SpellAgent.Hist.Tools do
  @moduledoc ~S|
    Durable lifecycle for runtime-authored tools (PLAN-001, C3).

    `SpellAgent.ToolRegistry` holds self-authored tools while a session is live,
    but it is in-memory and session-scoped. This module is the durability layer:
    it inventories which tools the agent authored in a session, counts their
    invocations and errors from the recorded `Node.sees`, and promotes the
    worthwhile ones into long-term `ToolDef` records stored under `{:tool, name}`.

    Promotion can be driven from the live registry (`promote/4`) or from an
    explicit map (`promote_from/3`) so the contract is testable without a running
    registry GenServer.
  |

  alias SpellAgent.Hist.{Store, ToolDef}

  @type inventory_entry :: %{
          name: String.t(),
          source: String.t() | nil,
          params: [atom()] | nil,
          doc: String.t() | nil,
          calls: non_neg_integer(),
          errors: non_neg_integer(),
          defined_node: String.t() | nil
        }

  @doc ~S|
    Inventory every tool the agent authored in `sid`.

    Authored names are taken from `Node.tools_defined`. Call/error counts are
    computed by scanning every node's `sees` for invocations of that name. The
    live `SpellAgent.ToolRegistry` supplies source/params/doc when present; a
    tool that has already dropped out of the registry still appears, just with
    nil metadata. `defined_node` is the id of the first node that declared it.
  |
  @spec inventory(module(), String.t()) :: [inventory_entry()]
  def inventory(impl, sid) do
    nodes = Store.list(impl, :node, sid)

    names =
      nodes
      |> Enum.flat_map(& &1.tools_defined)
      |> Enum.uniq()
      |> Enum.sort()

    Enum.map(names, fn name ->
      calls =
        nodes
        |> Enum.flat_map(& &1.sees)
        |> Enum.filter(&(&1[:name] == name))

      errors = Enum.count(calls, &error_result?/1)
      defined_node = Enum.find(nodes, fn n -> name in n.tools_defined end)
      registry_entry = SpellAgent.ToolRegistry.get(name)

      entry_for(name, calls, errors, defined_node && defined_node.id, registry_entry)
    end)
  end

  @doc ~S|
    Promote a live registry tool to durable storage.

    Looks the name up in `SpellAgent.ToolRegistry`. If found, delegates to
    `promote_from/3`. If not found, an explicit `origin` map with `:source`
    (and optionally `:params`, `:doc`, `:session`, `:node_id`) is accepted.
    Otherwise returns `{:error, :unknown_tool}`.
  |
  @spec promote(module(), String.t(), ToolDef.scope(), map() | nil) ::
          ToolDef.t() | {:error, :unknown_tool | :native_tool}
  def promote(impl, name, scope \\ :durable, origin \\ nil) do
    case SpellAgent.ToolRegistry.get(name) do
      {:ok, %{kind: :ptc} = entry} ->
        promote_from(impl, Map.put(entry, :name, name), scope)

      {:ok, %{kind: :native}} ->
        {:error, :native_tool}

      :error ->
        if is_map(origin) and is_binary(origin[:source]) do
          promote_from(impl, Map.put(origin, :name, name), scope)
        else
          {:error, :unknown_tool}
        end
    end
  end

  @doc ~S|
    Low-level promotion from an explicit tool descriptor.

    `descriptor` must contain `:name` and `:source`. `:params` and `:doc` are
    optional. If `:session` and `:node_id` are both present, they become the
    `ToolDef.origin`. Persists at `{:tool, name}` and returns the stored struct.
  |
  @spec promote_from(module(), map(), ToolDef.scope()) :: ToolDef.t()
  def promote_from(impl, %{name: name, source: source} = descriptor, scope \\ :durable) do
    origin =
      case descriptor do
        %{session: sid, node_id: nid} when is_binary(sid) and is_binary(nid) ->
          %{session: sid, node_id: nid}

        _ ->
          nil
      end

    tool = %ToolDef{
      name: name,
      source: source,
      params: descriptor[:params] || [],
      doc: descriptor[:doc],
      scope: scope,
      origin: origin,
      t: System.system_time(:millisecond)
    }

    :ok = Store.put(impl, {:tool, name}, tool)
    tool
  end

  @doc ~S|All promoted durable tools.|
  @spec durable(module()) :: [ToolDef.t()]
  def durable(impl) do
    Store.list(impl, :tool, nil)
  end

  @doc ~S|Remove a durable tool. Idempotent.|
  @spec prune(module(), String.t()) :: :ok
  def prune(impl, name) do
    Store.delete(impl, {:tool, name})
  end

  # --- internals ---

  defp entry_for(name, calls, errors, defined_node, registry_entry) do
    base = %{
      name: name,
      source: nil,
      params: nil,
      doc: nil,
      calls: length(calls),
      errors: errors,
      defined_node: defined_node
    }

    case registry_entry do
      {:ok, %{kind: :ptc, source: source, params: params, doc: doc}} ->
        %{base | source: source, params: params, doc: doc}

      {:ok, %{kind: :native, params: params, doc: doc}} ->
        %{base | params: params, doc: doc}

      _ ->
        base
    end
  end

  # Use the ONE shared classifier (BUG-001 B5) so inventory error counts match
  # what Query.tool_calls reports as :error.
  defp error_result?(%{result: result}), do: SpellAgent.Hist.Result.error?(result)
  defp error_result?(_), do: false
end
