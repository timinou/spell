defmodule SpellAgent.Tui.DataSource.Verb do
  @moduledoc """
  The `data-source/` tool surface (PLAN-027 M1, FUP-036) — the agent-facing verbs
  that let the MIND register its own query-clock `data/*` producers, the peer of
  `cell/` and `layout/`.

  A data source is a FROZEN PTC program run on the query clock (a `reproject`)
  through the read-only `DataSource.Tools` tier, its result merged into the
  `data/*` bag as `data/<name>`. Where `cell/` declares a FRAME-clock reactive
  query (debounced, off-process), `data-source/` declares a QUERY-clock heavy
  cross-cutting member (the multi-session cockpit's `data/sessions`, a cost
  histogram, a mesh view). Same "frozen program the mind authored" shape, one
  clock over.

  ## Verbs

    * `data-source/register {:name "sessions" :program (quote <read-only-program>)}`
      Register (or replace) a named query-clock source. `:program` is a QUOTED
      PTC form (codec data) — the deferred read-only program, the same shape a
      `cell/define :query` or a `tmpl::` hole carries. It runs with the
      `DataSource.Tools` read-only tier (`session-registry/lineage`,
      `hist/trace-summary`) + the `data/*` query-clock context. Returns
      `%{"ok" => true, "name" => …}` or `%{"err" => reason}`.

    * `data-source/list {}` — the registered source names as data (introspection).

    * `data-source/remove {:name "sessions"}` — unregister a source.

  ## Why `:program` must be quoted

  Same reason as `cell/define`: the program reads `data/*` and calls read-only
  tools that only exist at resolve time (on the query clock), so it must reach
  the registry as INERT codec data, not be evaluated now. `(quote form)` produces
  exactly that (PLAN-012 W0). The verb validates the arrived value is map-shaped
  codec data before storing.
  """

  alias SpellAgent.Tui.DataSource.Registry
  alias SpellAgent.Tui.Tree

  @doc "The `data-source/` verb tool map (qualified string names)."
  @spec tools() :: %{optional(String.t()) => (map() -> term())}
  def tools do
    %{
      "data-source/register" => &register/1,
      "data-source/list" => fn _args -> list() end,
      "data-source/remove" => &remove/1
    }
  end

  # ---- data-source/register ----

  defp register(args) when is_map(args) do
    name = strget(args, "name")
    program = strget(args, "program")

    cond do
      not is_binary(name) or name == "" ->
        %{"err" => "data-source/register requires a :name string"}

      not valid_program?(program) ->
        %{"err" => "data-source/register requires a :program (quote …) form (codec data)"}

      true ->
        case Registry.register(name, {:frozen, program}) do
          :ok -> %{"ok" => true, "name" => name}
          {:error, reason} -> %{"err" => "data-source/register rejected: #{reason}"}
        end
    end
  end

  defp register(_), do: %{"err" => "data-source/register requires an args map"}

  # ---- data-source/list ----

  defp list do
    Registry.names()
    |> Enum.map(fn name -> %{"name" => name} end)
  end

  # ---- data-source/remove ----

  defp remove(args) when is_map(args) do
    case strget(args, "name") do
      name when is_binary(name) ->
        Registry.unregister(name)
        %{"ok" => true, "name" => name}

      _ ->
        %{"err" => "data-source/remove requires a :name string"}
    end
  end

  defp remove(_), do: %{"err" => "data-source/remove requires an args map"}

  # ---- helpers ----

  # A frozen program is QUOTE codec data (a `"node"`-tagged map) OR a
  # hole/splice wrapper (a tmpl::-style frozen leaf) — the SAME shapes
  # `cell/define` accepts. A non-deferred value (string/number/plain map) is
  # rejected with a clear authoring error, never silently registered.
  defp valid_program?(%{"node" => _}), do: true
  defp valid_program?(%{"__hole__" => _}), do: true
  defp valid_program?(%{"__splice__" => _}), do: true
  defp valid_program?(_), do: false

  defp strget(args, key), do: Tree.get(args, key)
end
