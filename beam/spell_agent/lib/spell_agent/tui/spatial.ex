defmodule SpellAgent.Tui.Spatial do
  @moduledoc """
  Spatial region resolution (the `C-w` frame layer) — "select the region in this
  direction" answered PURELY by the laid-out geometry of the layout tree.

  The focus RING (`C-j`/`C-k`) cycles regions in tree order; this is its spatial
  dual: `C-w` + a direction (`h`/`j`/`k`/`l`) jumps to the EXTREME region along an
  axis — leftmost/rightmost/topmost/bottommost — read off the real `%Rect{}` each
  region occupies THIS frame. So "most rightward" is not a hardcoded slot; it is
  whichever region the layout placed furthest right (e.g. the cells drawer when it
  is shown on `C-e`, otherwise the rightmost body pane).

  Input is the same `[{slot, %Rect{}}]` the render walk produces (`Surface.layout`
  over the live tree, plus any overlay region). Output is the target slot string,
  or `nil` when there is nothing to move to. Pure; never raises on a degenerate
  set (empty list / zero rects → `nil`).
  """

  alias ExRatatui.Layout.Rect

  @type slot :: String.t()
  @type placement :: {slot(), Rect.t()}
  @type direction :: :left | :right | :up | :down

  @doc """
  The slot of the EXTREME region along `dir`, from the placed regions.

  Measured by the region's edge IN the direction of travel — the region that
  reaches FURTHEST that way wins:

    * `:right` — largest  right edge (`x + width`)
    * `:left`  — smallest left  edge (`x`)
    * `:down`  — largest  bottom edge (`y + height`)
    * `:up`    — smallest top   edge (`y`)

  Ties break by Z-ORDER: a region later in the list is drawn ON TOP, so it owns
  the zone (this is how the C-e cells drawer — an overlay appended last over the
  right column — wins `:right` against the body pane it occludes, even though that
  pane's left edge is further right). Returns `nil` for an empty set.
  """
  @spec extreme([placement()], direction()) :: slot() | nil
  def extreme(placements, dir) when is_list(placements) do
    placements
    |> Enum.filter(&valid_placement?/1)
    |> Enum.with_index()
    |> case do
      [] -> nil
      regions -> regions |> Enum.max_by(fn {p, i} -> rank(p, dir, i) end) |> elem(0) |> elem(0)
    end
  end

  def extreme(_placements, _dir), do: nil

  @doc "Parse a direction key (the chord after `C-w`) into a direction, or nil."
  @spec direction(String.t()) :: direction() | nil
  def direction("h"), do: :left
  def direction("l"), do: :right
  def direction("k"), do: :up
  def direction("j"), do: :down
  # Arrow keys are the same intent, for operators who reach for them.
  def direction("left"), do: :left
  def direction("right"), do: :right
  def direction("up"), do: :up
  def direction("down"), do: :down
  def direction(_), do: nil

  # A comparable rank tuple, max wins: {edge-toward-dir, z-index, slot}. The edge
  # is the region's boundary IN the direction of travel; `z` (its list position)
  # breaks ties so a later-placed overlay on top owns the zone; `slot` is a final
  # stable tiebreaker.
  defp rank({slot, %Rect{x: x, width: w}}, :right, z), do: {x + w, z, slot}
  defp rank({slot, %Rect{x: x}}, :left, z), do: {-x, z, slot}
  defp rank({slot, %Rect{y: y, height: h}}, :down, z), do: {y + h, z, slot}
  defp rank({slot, %Rect{y: y}}, :up, z), do: {-y, z, slot}

  defp valid_placement?({slot, %Rect{}}) when is_binary(slot), do: true
  defp valid_placement?(_), do: false
end
