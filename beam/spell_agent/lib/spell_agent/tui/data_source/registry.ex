defmodule SpellAgent.Tui.DataSource.Registry do
  @moduledoc """
  The QUERY-CLOCK data-source registry — the generic seam that lets a `data/*`
  binding be produced by a registered client WITHOUT the render loop naming that
  client (FUP-030 doctrine: the render loop is the PRIMITIVE, "where `data/sessions`
  comes from" is a POLICY registration at the periphery).

  ## Why this exists

  `DataBag.build/3` assembles the `data/*` bag from two cost tiers:

    * the FRAME clock (`assemble_light`) — cheap, per-keystroke members;
    * the QUERY clock — heavy members recomputed only on a `reproject` (a store
      update / navigation), cached across keystroke renders. `forest` and `vms`
      are the original two.

  A new heavy member (the multi-session cockpit's `data/sessions`, a live cost
  histogram, a mesh-blackboard view, …) is a THIRD kind of thing: query-clock
  data that is neither the local span forest nor a pane view-model. Before this
  registry, adding one meant the render loop (`App.reproject` + `DataBag.build`)
  hardcoding its NAME and its producing MODULE — the body naming a specific mind
  feature, the exact chakra-misalignment FUP-030 forbids.

  This registry dissolves that: a client REGISTERS a named producer once (at the
  periphery — boot, or a `.ptc` at maturity), and the render loop iterates the
  registry generically. `App.reproject` resolves every source on the query clock;
  `DataBag.build/3` merges the results as heavy members. Neither names `sessions`
  or `Cockpit`. Adding a query-clock `data/*` binding is now a registration, not
  a render-loop edit.

  ## The primitive vs. the policy

  This module + the resolve/merge wiring are the PRIMITIVE (Elixir — the
  query-clock cache mechanism). WHICH sources exist and WHAT they compute is
  POLICY: today an Elixir `register/2` at boot; the maximalist end-state (FUP,
  see moduledoc `SpellAgent.Tui.Cockpit`) is a frozen PTC producer calling
  read-only tools, so even the producer is data. This registry is shaped to
  accept that: a producer is any `(ctx -> term)`, and a PTC-thunk closing over a
  frozen program satisfies it unchanged.

  ## Relationship to Cell.Registry

  `Cell.Registry` also produces `data/*` bindings, but on a DIFFERENT clock: a
  debounced, dependency-diffed, off-process resolve tuned for frame-local
  reactive queries (a cursor-keyed lookup). This registry is the SYNCHRONOUS
  query-clock tier for heavy cross-cutting members. They are two clocks of one
  idea; unifying them into a single "reactive binding" abstraction is a filed
  follow-up (see FUP). Until then this is a focused sibling, not a parallel impl:
  it owns exactly the query-clock heavy tier `forest`/`vms` already live in.

  ## Bounds + never-brick

  Source NAMES are plain strings (bag map keys), so no atom interning — the
  atom-DoS concern `PaneRegistry` guards does not apply. The registry still caps
  the source COUNT (`@max_sources`) so a runaway client cannot unbound the
  per-reproject work. Every producer is resolved under try/rescue in
  `resolve_all/1`: a raising/exiting source is OMITTED from that reproject (the
  cache retains its last-good value from a prior resolve at the App layer), never
  crashing the render loop. A core bag key can never be shadowed — `DataBag`
  merges sources UNDER the canonical members.

  Session-global `Agent`, same supervision posture as the sibling registries
  (`Keymap`/`Pane`/`Theme`/`Layout`/`Cell`). In-memory v0; durable persistence
  is the shared registry-durability follow-up (FUP-009).
  """

  use Agent

  @typedoc """
  A data-source producer: a function from the query-clock CONTEXT to the value
  bound as `data/<name>`. The context carries the read-only bindings a source
  may need (`:hist_store`, `:store`, `:ui`, `:hist_session`) — a superset is
  passed so new sources need no signature change. Pure + best-effort: a producer
  that raises is dropped for that reproject (never-brick).
  """
  @type producer :: (map() -> term())

  # Cap on distinct registered sources. Bounds the per-reproject producer count
  # (each is one query-clock evaluation). Generous: the render surface has a
  # handful of heavy members, not hundreds.
  @max_sources 32

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  @doc """
  Register (or replace) the producer for `name` — the periphery policy call that
  says "`data/<name>` is produced by this query-clock thunk".

  Idempotent by name: re-registering `name` replaces its producer (a client that
  re-runs `install/0` does not grow the table). Returns `:ok`, or
  `{:error, reason}` when the name is invalid or the source cap is reached.
  Best-effort: a no-op `:ok` if the registry process is absent (a headless test),
  mirroring the sibling registries' posture.
  """
  @spec register(String.t(), producer()) :: :ok | {:error, String.t()}
  def register(name, producer)
      when is_binary(name) and is_function(producer, 1) do
    cond do
      name == "" ->
        {:error, "data-source name must not be empty"}

      not agent_up?() ->
        :ok

      true ->
        Agent.get_and_update(__MODULE__, fn sources ->
          cond do
            Map.has_key?(sources, name) ->
              {:ok, Map.put(sources, name, producer)}

            map_size(sources) >= @max_sources ->
              {{:error, "data-source limit reached (#{@max_sources})"}, sources}

            true ->
              {:ok, Map.put(sources, name, producer)}
          end
        end)
    end
  end

  def register(_name, _producer), do: {:error, "invalid data-source registration"}

  @doc "Remove a source by name (tests / teardown). No-op if absent."
  @spec unregister(String.t()) :: :ok
  def unregister(name) when is_binary(name) do
    if agent_up?(), do: Agent.update(__MODULE__, &Map.delete(&1, name)), else: :ok
  end

  @doc "The registered producers, `%{name => producer}`. `%{}` if the registry is down."
  @spec all() :: %{optional(String.t()) => producer()}
  def all do
    if agent_up?(), do: Agent.get(__MODULE__, & &1), else: %{}
  end

  @doc "The registered source names (introspection / a `data-sources` listing)."
  @spec names() :: [String.t()]
  def names, do: all() |> Map.keys()

  @doc """
  Resolve every registered source against the query-clock `ctx`, returning
  `%{name => value}` for the sources that produced a value.

  Each producer runs under try/rescue/catch: one that raises or exits is OMITTED
  (its `data/<name>` simply does not update this reproject — the App-level cache
  keeps its prior value), so a single sick source never breaks the render loop.
  Total: an absent registry yields `%{}`.
  """
  @spec resolve_all(map()) :: %{optional(String.t()) => term()}
  def resolve_all(ctx) when is_map(ctx) do
    all()
    |> Enum.reduce(%{}, fn {name, producer}, acc ->
      case safe_produce(producer, ctx) do
        {:ok, value} -> Map.put(acc, name, value)
        :error -> acc
      end
    end)
  rescue
    # Outer guard for the `all/0` TOCTOU race (review Sβ P2): `all/0` checks
    # `Process.whereis/1` then calls `Agent.get/2`; if the registry exits
    # BETWEEN those, `Agent.get/2` raises/exits. This best-effort seam must
    # NEVER propagate into `App.reproject/2` — an absent/restarting registry
    # yields no sources, exactly like an empty one.
    _ -> %{}
  catch
    _, _ -> %{}
  end

  @doc "Wipe all registered sources (test reset). Keeps the process."
  @spec reset() :: :ok
  def reset do
    if agent_up?(), do: Agent.update(__MODULE__, fn _ -> %{} end), else: :ok
  end

  # ---- internal ----

  defp safe_produce(producer, ctx) do
    {:ok, producer.(ctx)}
  rescue
    _ -> :error
  catch
    # Catch EVERY non-local exit — not just `:exit` (review Sβ P1): a producer
    # that `throw/1`s (or a `:throw`/`:error` non-local exit) would otherwise
    # bypass this clause and propagate out of `resolve_all/1` into the render
    # loop. A sick source is DATA (omitted), never a crash.
    _, _ -> :error
  end

  defp agent_up?, do: Process.whereis(__MODULE__) != nil
end
