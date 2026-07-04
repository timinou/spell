defmodule SpellAgent.Tui.PaneRegistry do
  @moduledoc """
  The runtime pane-name registry (PLAN-024 Wave 1 / FUP-005) — the bounded
  interning chokepoint that lets an agent name a NEW focusable pane at runtime,
  mirroring `KeymapRegistry.define_intent/1`'s pattern exactly.

  ## Why this exists

  `SpellAgent.Tui.Ui.safe_pane/1` coerces a string to a pane atom ONLY within a
  fixed compiled set (`:tree`/`:detail`/`:prompt`/`:history`/`:cells`) — the
  atom-table-DoS chokepoint (PLAN-346 W3r). That closed set is exactly what made
  an agent-added pane unfocusable in PLAN-009 v1 (FUP-005's problem statement): a
  new pane name coerces to `nil` everywhere the gaze touches it (focus, cursor,
  scroll), even though it can still RENDER as a body-slot shadow.

  This registry is the SAME bounded-intern discipline applied to a SECOND
  vocabulary: pane names. A name is validated (shape + length) and capped
  (`@max_runtime_panes`) BEFORE `String.to_atom/1` ever runs, and the SAME name
  reuses its already-interned atom on every subsequent call — so an agent cannot
  grow the atom table beyond the cap no matter how many times it "declares" the
  same or different pane names.

  ## The primitive vs. the policy (FUP-030 doctrine)

  This module is the PRIMITIVE (the bounded-intern invariant) — Elixir, because
  atom safety is not something PTC data can enforce on itself. Everything an
  agent DOES with a declared pane name — adding it to `body` via `layout/set`,
  wiring its content with `view/*` builders, binding its chords via
  `keymap/bind`, authoring its behaviour via `keymap/define-reaction` — is
  already 100% PTC-authored through existing verbs; this registry adds no new
  policy surface, only the one new bounded name-space a `harness/declare-pane`
  call opens up.

  v0 storage is in-memory (`Agent`), session-scoped — same posture as
  `KeymapRegistry`/`ToolRegistry`/`LayoutRegistry`. Durable persistence is
  FUP-009 (PLAN-024 Wave 4), which will cover this registry too.
  """

  use Agent

  # Cap on how many DISTINCT runtime pane atoms may be created via
  # `define_pane/1`. Atoms are never GC'd, so this bounds the atom-table growth
  # an agent's layout authoring can cause (atom-table-DoS defense, mirrors
  # KeymapRegistry's @max_runtime_intents). The compiled panes
  # (tree/detail/prompt/history/cells) already exist as atoms and don't count.
  @max_runtime_panes 64

  # A runtime pane name must be a short lowercase token (letters, digits,
  # hyphen/underscore) — no slashes (panes are not namespaced like intents), no
  # leading digit. Mirrors the KeymapRegistry shape-gate posture.
  @pane_pattern ~r{\A[a-z][a-z0-9_-]*\z}

  # Max pane-name length. `String.to_atom/1` raises past the VM atom byte limit
  # (255); a real pane name is short, so reject anything long BEFORE interning
  # (mirrors KeymapRegistry's @max_intent_bytes / final-review P2 lesson).
  @max_pane_bytes 32

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> MapSet.new() end, name: __MODULE__)
  end

  @doc """
  Resolve a runtime pane NAME (string) to an atom, creating the atom at most
  once and only within bounds (the single controlled atom-creation point for
  agent-declared pane names).

  Returns `{:ok, atom}` or `{:error, reason}`. Rules:
    * if the atom already exists (a compiled pane atom, or one declared
      earlier), reuse it — no new atom;
    * else require the pane-name SHAPE, a length under the cap, AND that the
      runtime-pane count is under `@max_runtime_panes`, then create + record it.
  """
  @spec define_pane(String.t()) :: {:ok, atom()} | {:error, String.t()}
  def define_pane(""), do: {:error, "pane name must not be empty"}

  def define_pane(name) when is_binary(name) do
    case existing_atom(name) do
      {:ok, atom} ->
        # An existing atom might be a compiled pane atom already known to
        # Ui.safe_pane's fixed set (:tree/:detail/...), or one this registry
        # itself declared earlier. Either way it's a no-op-safe reuse; also
        # record it here so `known?/1` recognizes the compiled panes too.
        Agent.update(__MODULE__, &MapSet.put(&1, atom))
        {:ok, atom}

      :error ->
        cond do
          byte_size(name) > @max_pane_bytes ->
            {:error, "pane name too long (max #{@max_pane_bytes} bytes)"}

          not Regex.match?(@pane_pattern, name) ->
            {:error, "pane name must match [a-z][a-z0-9_-]* (got #{inspect(name)})"}

          true ->
            Agent.get_and_update(__MODULE__, fn panes ->
              if MapSet.size(panes) >= @max_runtime_panes do
                {{:error, "runtime pane limit reached (#{@max_runtime_panes})"}, panes}
              else
                atom = String.to_atom(name)
                {{:ok, atom}, MapSet.put(panes, atom)}
              end
            end)
        end
    end
  end

  @doc "Whether `atom` is a known runtime-declared pane (registered via `define_pane/1`)."
  @spec known?(term()) :: boolean()
  def known?(atom) when is_atom(atom), do: Agent.get(__MODULE__, &MapSet.member?(&1, atom))
  def known?(_), do: false

  @doc """
  Look up a pane name STRING against the registry by VALUE (never interns) — the
  `safe_pane/1` fallback path. Returns the existing atom, or `nil` if no such
  atom has EVER been declared (whether by this registry or already loaded
  elsewhere), matching the never-intern posture of `Ui.safe_pane/1`.
  """
  @spec lookup(String.t()) :: atom() | nil
  def lookup(name) when is_binary(name) do
    case existing_atom(name) do
      {:ok, atom} -> if known?(atom), do: atom, else: nil
      :error -> nil
    end
  end

  def lookup(_), do: nil

  @doc "All runtime-declared pane atoms (for introspection / `keymap/intents`-style listing)."
  @spec all() :: [atom()]
  def all, do: Agent.get(__MODULE__, &MapSet.to_list/1)

  @doc "Wipe all declared panes (tests / session reset). Keeps the process."
  @spec reset() :: :ok
  def reset, do: Agent.update(__MODULE__, fn _ -> MapSet.new() end)

  defp existing_atom(name) do
    {:ok, String.to_existing_atom(name)}
  rescue
    ArgumentError -> :error
  end
end
