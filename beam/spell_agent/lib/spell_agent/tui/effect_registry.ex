defmodule SpellAgent.Tui.EffectRegistry do
  @moduledoc """
  The bounded App-effect registry (PLAN-027 M5, FUP-040) — the ACT-half analogue
  of `Ui.safe_pane/1`'s bounded-intern for the LOOK half.

  ## Why this exists

  A reaction is a pure gaze/tree transform: `data → data`. It cannot express an
  App-level EFFECT — halting the runtime, entering the frame leader, submitting a
  mission, drilling the cockpit into a session. Those live as welded Elixir
  clauses in `App.handle_key_event/2`. M5 lets a reaction RETURN a data-tagged
  effect (`{:effect, name, args}`); the body interprets it through THIS registry.
  Adding a new App effect becomes a REGISTRATION, not a new dispatch clause.

  ## The bounded-effect invariant (security is load-bearing)

  An effect NAME arriving from a reaction is untrusted DATA. It is looked up in
  this FIXED registry: an unknown name is a NO-OP, never an arbitrary call. This
  is the exact discipline `Ui.safe_pane/1` applies to the look half — the act
  half must be equally airtight. A reaction can only invoke effects the body has
  registered; it can invent none.

  ## Protected effects (the kill-switch firewall)

  Some effects must NEVER be reachable from a reaction-returned value:
  `app/quit` is the safe kill switch — a runaway or hostile reaction returning
  `{:effect \"app/quit\"}` to close the app is a HAZARD, not a feature (oracle
  M5 Q2). A `protected?` effect is registered but `invoke/3` REFUSES to run it
  from the reaction path — it can only fire from the hardcoded
  `handle_key_event/2` interceptor (a real key the human pressed). So protection
  means two things: (a) `keymap/define-reaction` cannot redefine the intent
  (enforced in App), and (b) a reaction-returned effect cannot invoke the handler
  (enforced HERE). Agent-requested close, if ever wanted, is a separate
  unprotected `app/request-quit` with soft/confirm semantics — never this.

  ## Handler contract

  A handler is `(state, args -> {:noreply, state} | {:stop, state})` — the same
  return shape `handle_key_event/2` produces, so the App threads it straight
  through. The handler runs ON the App process (it mutates App state:
  focus/drill/pending — things a pure gaze transform can't reach); it must be
  fast and total (a raising handler is caught at the App boundary → no-op).

  Session-global `Agent`, same posture as the sibling registries. In-memory v0;
  durable persistence is FUP-041 (but effects are compiled handlers, so they are
  re-registered at boot regardless — not durable state).
  """

  use Agent

  @typedoc "An effect handler: mutate App state, return the App's key-event reply shape."
  @type handler :: (map(), map() -> {:noreply, map()} | {:stop, map()})

  @typedoc "A registered effect: its handler + whether it is reaction-unreachable (protected)."
  @type entry :: %{handler: handler(), protected?: boolean()}

  # Cap on distinct registered effects. Bounds the act-half vocabulary a reaction
  # can name (mirrors the look-half caps in Ui/PaneRegistry).
  @max_effects 64

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  @doc """
  Register (or replace) an App effect `name` with its `handler`.

  `opts[:protected?]` (default false) marks the effect reaction-UNREACHABLE — it
  can only fire from a hardcoded key interceptor, never from a reaction-returned
  `{:effect, name, ...}` (the kill-switch firewall). Idempotent by name;
  best-effort (a no-op if the registry is absent).
  """
  @spec register(String.t(), handler(), keyword()) :: :ok | {:error, String.t()}
  def register(name, handler, opts \\ [])

  def register(name, handler, opts)
      when is_binary(name) and is_function(handler, 2) do
    protected? = Keyword.get(opts, :protected?, false)
    entry = %{handler: handler, protected?: protected?}

    cond do
      name == "" ->
        {:error, "effect name must not be empty"}

      not agent_up?() ->
        :ok

      true ->
        Agent.get_and_update(__MODULE__, fn effects ->
          cond do
            Map.has_key?(effects, name) -> {:ok, Map.put(effects, name, entry)}
            map_size(effects) >= @max_effects -> {{:error, "effect limit reached (#{@max_effects})"}, effects}
            true -> {:ok, Map.put(effects, name, entry)}
          end
        end)
    end
  end

  def register(_name, _handler, _opts), do: {:error, "invalid effect registration"}

  @doc """
  Invoke effect `name` from the REACTION path against App `state` + `args`.

  Returns the handler's `{:noreply|:stop, state}` reply, or `{:noreply, state}`
  unchanged when:
    * `name` is unknown (the bounded-effect invariant — never an arbitrary call);
    * `name` is PROTECTED (the kill-switch firewall — a reaction cannot invoke it);
    * the handler raises/exits (caught here — never bricks the input path).

  So a reaction-returned effect is always safe: at worst a no-op.
  """
  @spec invoke(String.t(), map(), map()) :: {:noreply, map()} | {:stop, map()}
  def invoke(name, state, args) when is_binary(name) and is_map(state) do
    case lookup(name) do
      %{protected?: true} ->
        # The firewall: a protected effect (app/quit) is unreachable from a
        # reaction. Silently no-op — the reaction does not get to halt the app.
        {:noreply, state}

      %{handler: handler} ->
        run(handler, state, args)

      nil ->
        # Unknown effect: bounded-effect invariant — a reaction cannot name an
        # effect the body didn't register. No-op.
        {:noreply, state}
    end
  end

  def invoke(_name, state, _args) when is_map(state), do: {:noreply, state}

  @doc "The entry for `name`, or nil. Best-effort (nil when the registry is down)."
  @spec lookup(String.t()) :: entry() | nil
  def lookup(name) when is_binary(name) do
    # TOCTOU guard (review Sβ P2): `agent_up?()` then `Agent.get/2` — if the
    # registry exits BETWEEN them while a reaction-returned effect is being
    # interpreted, `Agent.get/2` exits. This must degrade to nil (→ no-op effect),
    # never propagate into the input path.
    if agent_up?(), do: Agent.get(__MODULE__, &Map.get(&1, name)), else: nil
  rescue
    _ -> nil
  catch
    _, _ -> nil
  end

  def lookup(_), do: nil

  @doc "Whether `name` is a registered effect (any protection)."
  @spec registered?(String.t()) :: boolean()
  def registered?(name) when is_binary(name), do: lookup(name) != nil
  def registered?(_), do: false

  @doc "All registered effect names (introspection / tests)."
  @spec names() :: [String.t()]
  def names do
    if agent_up?(), do: Agent.get(__MODULE__, &Map.keys(&1)), else: []
  end

  @doc "Wipe all effects (test reset). Keeps the process."
  @spec reset() :: :ok
  def reset do
    if agent_up?(), do: Agent.update(__MODULE__, fn _ -> %{} end), else: :ok
  end

  # ---- internal ----

  defp run(handler, state, args) do
    case handler.(state, args) do
      {:noreply, new_state} when is_map(new_state) -> {:noreply, new_state}
      {:stop, new_state} when is_map(new_state) -> {:stop, new_state}
      # A handler that returns a bare state (or garbage) degrades to no-op with
      # the ORIGINAL state — a handler contract violation never corrupts App state.
      new_state when is_map(new_state) -> {:noreply, new_state}
      _ -> {:noreply, state}
    end
  rescue
    _ -> {:noreply, state}
  catch
    _, _ -> {:noreply, state}
  end

  defp agent_up?, do: Process.whereis(__MODULE__) != nil
end
