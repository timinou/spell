defmodule SpellAgent.Tui.ThemeRegistry do
  @moduledoc """
  Live, runtime-mutable theme palette (PLAN-009, Edge T) — the cross-cutting
  color surface, mirroring `KeymapRegistry`/`ToolRegistry`.

  Theme is NOT a per-slot override; it is a named-slot palette
  (`ExRatatui.Theme`) that `view/` builders read DEFAULTS from. Recoloring
  "errors magenta" is one op here, not an edit to every slot that shows an error.

  The slot vocabulary is reflected from `ExRatatui.Theme` (see
  `SpellAgent.Tui.Reflect.theme_slots/0`), so a new palette slot upstream is
  accepted automatically. Values are `ExRatatui.Style` colors: a named-color
  string (`"magenta"`), an `{:rgb,...}`/`{:indexed,...}` map, or nil.

  v0 storage is in-memory (Agent), session-scoped — same posture as the other
  registries. Durable palettes are folded into FUP-009.
  """

  use Agent

  alias SpellAgent.Tui.{Materialize, Reflect}

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> ExRatatui.Theme.default() end, name: __MODULE__)
  end

  @doc "The live theme struct."
  @spec theme() :: ExRatatui.Theme.t()
  def theme, do: Agent.get(__MODULE__, & &1)

  @doc "The live theme as a plain string-keyed map (what a PTC program reads)."
  @spec as_map() :: %{optional(String.t()) => term()}
  def as_map do
    t = theme()

    for slot <- Reflect.theme_slots(), into: %{} do
      {Atom.to_string(slot), color_to_wire(Map.get(t, slot))}
    end
  end

  @doc """
  Set one palette slot. `slot` is a known Theme slot name (string/atom); `color`
  is a color string / rgb-map / indexed-map / nil. Unknown slots are ignored
  (bounded; never interns). Returns `:ok`.
  """
  @spec put(String.t() | atom(), term()) :: :ok | {:error, String.t()}
  def put(slot, color) do
    case known_slot(slot) do
      nil ->
        {:error, "unknown theme slot #{inspect(slot)}; allowed: #{slots_list()}"}

      atom ->
        Agent.update(__MODULE__, &Map.put(&1, atom, coerce_color(color)))
        :ok
    end
  end

  @doc "Reset to the default palette (tests / sessions)."
  @spec reset() :: :ok
  def reset, do: Agent.update(__MODULE__, fn _ -> ExRatatui.Theme.default() end)

  # ---- helpers ----

  defp known_slot(slot) do
    slots = Reflect.theme_slots()

    cond do
      is_atom(slot) and slot in slots -> slot
      is_binary(slot) -> Enum.find(slots, &(Atom.to_string(&1) == slot))
      true -> nil
    end
  end

  defp slots_list, do: Reflect.theme_slots() |> Enum.map_join(", ", &Atom.to_string/1)

  # Reuse Materialize's color coercion via a throwaway Style, so theme colors
  # accept the exact same wire forms view/ builders do (no parallel coercion).
  defp coerce_color(c) do
    %{fg: fg} = Materialize.to_struct(%{"type" => "style", "fg" => c})
    fg
  end

  defp color_to_wire(nil), do: nil
  defp color_to_wire(a) when is_atom(a), do: Atom.to_string(a)
  defp color_to_wire({:rgb, r, g, b}), do: %{"type" => "rgb", "r" => r, "g" => g, "b" => b}
  defp color_to_wire({:indexed, i}), do: %{"type" => "indexed", "value" => i}
  defp color_to_wire(other), do: other
end
