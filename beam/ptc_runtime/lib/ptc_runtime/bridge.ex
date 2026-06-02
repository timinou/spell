defmodule PtcRuntime.Bridge do
  @moduledoc """
  Catalog → PTC-Lisp tools map. The Node↔BEAM bridge's BEAM half.

  Each tool advertised in the `init` catalog becomes an arity-1 PTC-Lisp tool
  function. When a program reaches `(tool/<name> {...})`, the runtime invokes
  that function inside the sandbox; the function issues a reentrant `tool_call`
  back to Node via `PtcRuntime.Peer.tool_call/3` and returns Node's result as
  the value of the form.

  ## Catalog shape (from Node `init`)

      %{
        "tools" => [
          %{"name" => "find", "signature" => "(target :string) -> {chunks [:map]}",
            "effect" => "read"},
          ...
        ],
        "providers" => [%{"alias" => "fast", "model" => "anthropic/claude-haiku-4-5"}]
      }

  Only `name` is required to wire the callback. `signature`/`effect`/`description`
  are planner guidance (P2 codegen) and policy input (P3 gate). In P0/P1 every
  named tool is wired; the effect-tag *policy gate* lands in P3.

  ## Why a function per tool (not one generic `tool/call`)

  PTC-Lisp dispatches `(tool/find ...)` by the tool's registered string key.
  Wiring one closure per name gives programs the natural kebab-case surface the
  LLM expects (`(tool/find {...})`), not an awkward `(tool/call {:tool ...})`.
  """

  alias PtcRuntime.Peer

  @doc """
  Build the `%{name => fn}` tools map PtcRunner.Lisp expects, from a catalog.

  `peer` is the Peer server the tool callbacks route through (passed explicitly
  so tests can inject a stub).
  """
  @spec build_tools(map(), GenServer.server(), term()) :: %{optional(String.t()) => function()}
  def build_tools(catalog, peer, exec_id \\ nil) do
    catalog
    |> Map.get("tools", [])
    |> Enum.reduce(%{}, fn entry, acc ->
      case tool_name(entry) do
        nil -> acc
        name -> Map.put(acc, name, make_callback(name, peer, exec_id))
      end
    end)
  end

  @doc "Sorted list of wired tool names (echoed back in the init response)."
  @spec tool_names(%{optional(String.t()) => function()}) :: [String.t()]
  def tool_names(tools), do: tools |> Map.keys() |> Enum.sort()

  # Each tool is an arity-1 fn taking a string-keyed arg map (PtcRunner contract)
  # and routing to Node. The closure captures the tool name + peer + the
  # originating execute's id, so the reentrant tool_call frame can identify
  # which execute it belongs to (Node selects the matching per-execute abort
  # signal). `exec_id` is nil only for the init-time names probe (no calls run).
  defp make_callback(name, peer, exec_id) do
    fn args when is_map(args) -> Peer.tool_call(peer, name, args, exec_id) end
  end

  defp tool_name(%{"name" => name}) when is_binary(name) and name != "", do: name
  defp tool_name(_), do: nil
end
