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

  alias SpellAgent.Tui.Registry.Durable

  # The durable-store key for the frozen data-source programs (PLAN-027 M7).
  @durable_kind :data_source
  @durable_name "sources"

  @typedoc """
  A data-source producer. Two shapes (PLAN-027 M0 then M1):

    * an Elixir CLOSURE `(ctx -> value)` — the M0 interim form (`Cockpit.install/0`);
    * a FROZEN PTC PROGRAM `{:frozen, codec_data}` — the M1 maximalist form: a
      quoted program the mind authored via `data-source/register`, run on the
      query clock through `Cell.resolve/3` with the read-only `DataSource.Tools`
      tier. The body no longer names the feature; the mind registers its own.

  Either way it maps the query-clock CONTEXT (carrying `:hist_store`, `:store`,
  `:ui`, `:hist_session`, `:forest` — a superset, so new sources need no signature
  change) to the value bound as `data/<name>`. Pure + best-effort: a producer
  that fails is dropped for that reproject (never-brick).
  """
  @type producer :: (map() -> term()) | {:frozen, term()}

  # Cap on distinct registered sources. Bounds the per-reproject producer count
  # (each is one query-clock evaluation). Generous: the render surface has a
  # handful of heavy members, not hundreds.
  @max_sources 32

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(opts \\ []) do
    # `:name` defaults to the module (the supervised singleton); a test may pass
    # `name: nil` (or a custom name) to start an isolated instance against an
    # injected store without colliding with the app singleton.
    name = Keyword.get(opts, :name, __MODULE__)
    Agent.start_link(fn -> init_state(opts) end, name: name)
  end

  # State: the sources map + durability config (PLAN-027 M7). Durability is
  # OPT-IN (`durable: true`) — same posture as LayoutRegistry — and when on, the
  # FROZEN sources (plain codec data; closures can't persist) are mirrored to the
  # store on every mutation and rehydrated here at boot.
  defp init_state(opts) do
    durable? = Keyword.get(opts, :durable, false)
    store = Keyword.get(opts, :store, Durable.default_store())

    sources =
      if durable? do
        Durable.rehydrate(store, {@durable_kind, @durable_name}, %{}, &valid_persisted?/1)
        |> restore_frozen()
      else
        %{}
      end

    %{sources: sources, durable?: durable?, store: store}
  end

  # A persisted blob is a `%{name => codec_data}` map of frozen programs. Restore
  # each as a `{:frozen, program}` producer. A non-map blob is rejected (-> %{}).
  defp restore_frozen(blob) when is_map(blob) do
    Map.new(blob, fn {name, program} -> {name, {:frozen, program}} end)
  end

  defp restore_frozen(_), do: %{}

  defp valid_persisted?(blob), do: is_map(blob)

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
      when is_binary(name) and
             (is_function(producer, 1) or
                (is_tuple(producer) and tuple_size(producer) == 2 and elem(producer, 0) == :frozen)) do
    cond do
      name == "" ->
        {:error, "data-source name must not be empty"}

      not agent_up?() ->
        :ok

      true ->
        Agent.get_and_update(__MODULE__, fn st ->
          sources = st.sources

          cond do
            Map.has_key?(sources, name) ->
              commit(st, Map.put(sources, name, producer))

            map_size(sources) >= @max_sources ->
              {{:error, "data-source limit reached (#{@max_sources})"}, st}

            true ->
              commit(st, Map.put(sources, name, producer))
          end
        end)
    end
  end

  def register(_name, _producer), do: {:error, "invalid data-source registration"}

  # Commit a new sources map into the state and, when durable, mirror the FROZEN
  # subset to the store INSIDE this same Agent callback (atomic with the in-memory
  # commit — the LayoutRegistry/ToolRegistry discipline). Only frozen programs are
  # persisted; an Elixir closure (the interim boot producer) can't serialize, so
  # it is re-registered at boot regardless. Best-effort persist (never fails the
  # mutation).
  defp commit(st, sources) do
    st = %{st | sources: sources}
    maybe_persist(st)
    {:ok, st}
  end

  defp maybe_persist(%{durable?: true, store: store} = st) do
    frozen =
      for {name, {:frozen, program}} <- st.sources, into: %{} do
        {name, program}
      end

    Durable.persist(store, {@durable_kind, @durable_name}, frozen)
  end

  defp maybe_persist(_st), do: :ok

  @doc "Remove a source by name (tests / teardown). No-op if absent."
  @spec unregister(String.t()) :: :ok
  def unregister(name) when is_binary(name) do
    if agent_up?() do
      Agent.update(__MODULE__, fn st ->
        st = %{st | sources: Map.delete(st.sources, name)}
        maybe_persist(st)
        st
      end)
    else
      :ok
    end
  end

  @doc "The registered producers, `%{name => producer}`. `%{}` if the registry is down."
  @spec all() :: %{optional(String.t()) => producer()}
  def all do
    if agent_up?(), do: Agent.get(__MODULE__, & &1.sources), else: %{}
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
    if agent_up?() do
      Agent.update(__MODULE__, fn st ->
        st = %{st | sources: %{}}
        maybe_persist(st)
        st
      end)
    else
      :ok
    end
  end

  @doc """
  Enable durability on the already-running registry (PLAN-027 M7), rehydrating
  any previously persisted frozen sources. Mirrors `LayoutRegistry.enable_durability/1`:
  the registry boots once with fixed opts, so a `--durable` launch flips the
  live singleton. Best-effort.
  """
  @spec enable_durability(keyword()) :: :ok
  def enable_durability(opts \\ []) do
    store = Keyword.get(opts, :store, Durable.default_store())

    if agent_up?() do
      Agent.update(__MODULE__, fn st ->
        restored =
          Durable.rehydrate(store, {@durable_kind, @durable_name}, %{}, &valid_persisted?/1)
          |> restore_frozen()

        # Merge restored frozen sources OVER the current (so a boot-registered
        # closure for the same name is replaced by its durable frozen version).
        %{st | durable?: true, store: store, sources: Map.merge(st.sources, restored)}
      end)
    else
      :ok
    end
  end

  # ---- internal ----

  # Run a producer against the query-clock ctx, dispatching on its shape:
  #   * a FROZEN PTC program runs through `Cell.resolve/3` (the exact off-frame
  #     sandbox cells use) with the read-only `DataSource.Tools` tier built from
  #     the ctx — the M1 maximalist path where the producer is data the mind
  #     authored, not Elixir the body named;
  #   * an Elixir CLOSURE is called directly (the M0 interim path).
  # Either way total: any failure collapses to `:error` and the source is
  # omitted. Catch EVERY non-local exit — not just `:exit` (review Sβ P1): a
  # producer that `throw/1`s must not propagate out of `resolve_all/1` into the
  # render loop. A sick source is DATA (omitted), never a crash.
  defp safe_produce({:frozen, program}, ctx) do
    tier = SpellAgent.Tui.DataSource.Tools.read_only(ctx)

    case SpellAgent.Tui.Cell.resolve(program, stringify_ctx(ctx), tier) do
      {:ok, value} -> {:ok, value}
      :error -> :error
    end
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  defp safe_produce(producer, ctx) when is_function(producer, 1) do
    {:ok, producer.(ctx)}
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  defp safe_produce(_producer, _ctx), do: :error

  # A frozen program reads its inputs as `data/*` (string keys), exactly like a
  # cell / render hole. The query-clock ctx is atom-keyed (`:hist_store`, `:ui`,
  # `:forest`) — string-key it so a program can read e.g. `data/forest`. The
  # store handles (`:hist_store`/`:store`) stay reachable to the TOOLS (closed
  # over the raw ctx in `DataSource.Tools.read_only/1`), not as data.
  defp stringify_ctx(ctx) do
    Map.new(ctx, fn {k, v} -> {to_string(k), v} end)
  end

  defp agent_up?, do: Process.whereis(__MODULE__) != nil
end
