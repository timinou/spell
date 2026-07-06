defmodule SpellAgent.Tui.Registry.Durable do
  @moduledoc """
  One durable-persistence mechanism for the sibling registries (PLAN-027 M7,
  FUP-041) — the generalization of `LayoutRegistry`'s proven durability hooks.

  ## Why this exists

  Every sibling registry (`Keymap`/`Pane`/`Theme`/`Layout`/`Cell`/`DataSource`/
  `PaneContext`/`Effect`) is an in-memory `Agent`, session-scoped, so
  agent-authored policy (rebinds, layouts, themes, sources) is re-derived every
  session — the mind cannot ACCUMULATE (the "taught vs learned" boundary from
  freeform-tui-philosophy). `LayoutRegistry` + `KeymapRegistry` each grew their
  OWN durability hooks; M7 lifts that pattern into ONE helper so a registry adds
  persistence with a `persist/3` call in its mutating callback and a
  `rehydrate/4` call at boot — no bespoke per-registry durability code.

  ## The mechanism (verbatim from LayoutRegistry, generalized)

  A durable registry mirrors its state to `Store.put(store, {kind, name}, data)`
  from INSIDE the same Agent callback as the in-memory commit, so the store write
  is atomic with the state change (the ToolRegistry discipline). At boot it
  rehydrates via `Store.fetch`, running the persisted value through a caller-
  supplied `validate` predicate; ANY failure (absent key, sick store, invalid
  value) falls back to the native default — the failure ladder that keeps a stale
  or corrupt blob from bricking boot.

  ## Never-brick + bounds

  - `persist/3` is best-effort: a sick store never fails the caller's mutation.
  - `rehydrate/4` falls back to `default` on absent/sick/invalid — never raises.
  - `validate` is the caller's contract (e.g. `LayoutDiagnostic.validate == :ok`,
    or a size/shape check); an invalid persisted blob degrades to `default`.

  Not every registry SHOULD be durable: `EffectRegistry` holds compiled handlers
  (re-registered at boot, non-durable by design), `PaneContext` holds a native
  seed. This helper is for the registries with AGENT-AUTHORED state worth
  carrying across sessions (Theme recolors, DataSource frozen programs, on top of
  the already-durable Keymap/Layout).
  """

  alias SpellAgent.Hist
  alias SpellAgent.Hist.Store

  @typedoc "A validator: returns true when a rehydrated value is acceptable."
  @type validator :: (term() -> boolean())

  @doc """
  The default store durable registries persist to (the Hist store). A registry
  may inject its own for tests.
  """
  @spec default_store() :: module()
  def default_store, do: Hist.default_store()

  @doc """
  Persist `value` for a registry under `{kind, name}`. Best-effort: a sick/absent
  store is a no-op, never raising into the caller's mutation. Returns `:ok`.

  Call this from INSIDE the registry's mutating Agent callback (after computing
  the new state) so the store write is atomic with the in-memory commit.
  """
  @spec persist(module() | nil, {atom(), String.t()}, term()) :: :ok
  def persist(nil, _key, _value), do: :ok

  def persist(store, {kind, name} = _key, value)
      when is_atom(kind) and is_binary(name) do
    safe(fn -> Store.put(store, {kind, name}, value) end)
    :ok
  end

  def persist(_store, _key, _value), do: :ok

  @doc """
  Rehydrate the persisted value for `{kind, name}` from `store`, falling back to
  `default` on ANY failure: absent key, sick/unstarted store, or a value that
  fails `validate`. Never raises.

  `validate` is the caller's acceptance predicate (the failure-ladder gate that
  keeps a stale/corrupt blob from being adopted). A registry with no meaningful
  validation passes `fn _ -> true end`.
  """
  @spec rehydrate(module() | nil, {atom(), String.t()}, term(), validator()) :: term()
  def rehydrate(nil, _key, default, _validate), do: default

  def rehydrate(store, {kind, name}, default, validate)
      when is_atom(kind) and is_binary(name) and is_function(validate, 1) do
    ensure_started(store)

    case safe_fetch(store, {kind, name}) do
      {:ok, persisted} ->
        if validate_safe(validate, persisted), do: persisted, else: default

      _ ->
        default
    end
  end

  def rehydrate(_store, _key, default, _validate), do: default

  # ---- internal (the ladder, verbatim from LayoutRegistry) ----

  defp ensure_started(store) do
    cond do
      function_exported?(store, :start, 0) -> safe(fn -> store.start() end)
      function_exported?(store, :start, 1) -> safe(fn -> store.start(nil) end)
      true -> :ok
    end
  end

  defp safe_fetch(store, key) do
    Store.fetch(store, key)
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  defp validate_safe(validate, value) do
    validate.(value) == true
  rescue
    _ -> false
  catch
    _, _ -> false
  end

  defp safe(fun) do
    fun.()
    :ok
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end
end
