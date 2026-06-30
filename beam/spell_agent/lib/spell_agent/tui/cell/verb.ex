defmodule SpellAgent.Tui.Cell.Verb do
  @moduledoc """
  The `cell/` tool surface (PROJ-004 W2) — the agent-facing declaration verbs for
  reactive cells, the peer of `layout/` and `keymap/define-reaction`.

  Registered into the live tools map via `tools/0` (merged in `SpellAgent.Tools`),
  routed through the `cell/` namespace SPELL-PATCHed into the analyzer. A cell is
  DECLARED here and resolved off-frame by the slow clock (W3); this module only
  writes the declaration into `SpellAgent.Tui.Cell.Registry`.

  ## Verbs

    * `cell/define {:name "callers" :query (quote <read-only-query>) :debounce 80}`
      Declare (or replace) a named reactive cell. `:query` is a QUOTED PTC form
      (codec data) — the deferred read-only query, the same shape a `tmpl::` hole
      carries. Returns `%{"ok" => true, "name" => …, "deps" => [...]}` or
      `%{"err" => reason}`.

    * `cell/list {}` — the declared cells as data (name, deps, debounce, whether
      resolved). For introspection + the prelude demo.

    * `cell/remove {:name "callers"}` — undeclare a cell.

  ## Why `:query` must be quoted

  The query has to reach the registry as INERT codec data, not be evaluated at
  declaration time (it reads `data/*` that only exists at resolve time, and may
  call read-only tools that must run on the slow clock, not now). `(quote form)`
  produces exactly that codec data (PLAN-012 W0), so the author writes
  `:query (quote (harness/descendants {:id (get data/ui :cursor-id)}))`. The verb
  validates the arrived value is map-shaped codec data before storing.
  """

  alias SpellAgent.Tui.Cell.Registry
  alias SpellAgent.Tui.Tree

  @doc "The `cell/` verb tool map (qualified string names)."
  @spec tools() :: %{optional(String.t()) => (map() -> term())}
  def tools do
    %{
      "cell/define" => &define/1,
      "cell/list" => fn _args -> list() end,
      "cell/remove" => &remove/1
    }
  end

  # ---- cell/define ----

  defp define(args) when is_map(args) do
    name = strget(args, "name")
    query = strget(args, "query")
    debounce = strget(args, "debounce")

    cond do
      not is_binary(name) ->
        %{"err" => "cell/define requires a :name string"}

      not valid_query?(query) ->
        %{"err" => "cell/define requires a :query (quote …) form (codec data)"}

      true ->
        opts = if is_integer(debounce), do: [debounce: debounce], else: []

        case Registry.define(name, query, opts) do
          {:ok, cell} ->
            %{"ok" => true, "name" => name, "deps" => MapSet.to_list(cell.deps)}

          {:error, reason} ->
            %{"err" => "cell/define rejected: #{reason}"}
        end
    end
  end

  defp define(_), do: %{"err" => "cell/define requires an args map"}

  # ---- cell/list ----

  defp list do
    Registry.all()
    |> Enum.map(fn {name, cell} ->
      %{
        "name" => name,
        "deps" => MapSet.to_list(cell.deps),
        "debounce" => cell.debounce,
        "resolved" => cell.resolved != :unresolved
      }
    end)
  end

  # ---- cell/remove ----

  defp remove(args) when is_map(args) do
    case strget(args, "name") do
      name when is_binary(name) ->
        Registry.remove(name)
        %{"ok" => true, "name" => name}

      _ ->
        %{"err" => "cell/remove requires a :name string"}
    end
  end

  defp remove(_), do: %{"err" => "cell/remove requires an args map"}

  # ---- helpers ----

  # A frozen query is QUOTE codec data: a map carrying a "node" tag (the shape
  # `quote` produces), OR a hole/splice wrapper (a tmpl::-style frozen leaf). We
  # check the shape HERE so a non-deferred query — a string, a number, or a plain
  # map literal that is NOT codec data — is rejected with a clear authoring error
  # at define time, rather than silently registering a cell that resolves to
  # nothing. (W4r: the quote-required contract must be enforced, not deferred.)
  defp valid_query?(%{"node" => _}), do: true
  defp valid_query?(%{"__hole__" => _}), do: true
  defp valid_query?(%{"__splice__" => _}), do: true
  defp valid_query?(_), do: false

  defp strget(args, key), do: Tree.get(args, key)
end
