defmodule SpellAgent.Tui.SpatialTest do
  @moduledoc """
  The frame leader's spatial core (C-w): "select the region in this direction" is
  answered by rect GEOMETRY, not a hardcoded slot. These defend the one contract
  the App leans on — `extreme/2` returns whichever placed region sits furthest
  along the axis — plus the direction-key mapping.
  """
  use ExUnit.Case, async: true

  alias ExRatatui.Layout.Rect
  alias SpellAgent.Tui.Spatial

  # The native body arrangement: history | tree | detail, left to right.
  defp body do
    [
      {"history", %Rect{x: 0, y: 0, width: 34, height: 24}},
      {"tree", %Rect{x: 34, y: 0, width: 30, height: 24}},
      {"detail", %Rect{x: 64, y: 0, width: 36, height: 24}}
    ]
  end

  describe "extreme/2 — the extreme region by geometry" do
    test "right picks the rightmost rect, left the leftmost" do
      assert Spatial.extreme(body(), :right) == "detail"
      assert Spatial.extreme(body(), :left) == "history"
    end

    test "a rightmost OVERLAY (the C-e cells drawer) wins :right by position" do
      # The cells drawer is drawn furthest right; C-w l must land on it because it
      # IS the most-rightward region now, not because it is special-cased.
      regions = body() ++ [{"cells", %Rect{x: 66, y: 0, width: 34, height: 24}}]
      assert Spatial.extreme(regions, :right) == "cells"
      # ... and removing it returns :right to the rightmost body pane.
      assert Spatial.extreme(body(), :right) == "detail"
    end

    test "vertical axis: down picks the bottommost, up the topmost" do
      stack = [
        {"status", %Rect{x: 0, y: 0, width: 80, height: 3}},
        {"body", %Rect{x: 0, y: 3, width: 80, height: 18}},
        {"composer", %Rect{x: 0, y: 21, width: 80, height: 3}}
      ]

      assert Spatial.extreme(stack, :down) == "composer"
      assert Spatial.extreme(stack, :up) == "status"
    end

    test "empty / malformed sets resolve to nil (total, never raises)" do
      assert Spatial.extreme([], :right) == nil
      assert Spatial.extreme([{"x", :not_a_rect}], :left) == nil
      assert Spatial.extreme(:garbage, :down) == nil
    end

    test "ties on the primary axis break deterministically (cross axis)" do
      # Two regions share x; the topmost (smaller y) wins :right.
      tied = [
        {"low", %Rect{x: 10, y: 10, width: 5, height: 5}},
        {"high", %Rect{x: 10, y: 0, width: 5, height: 5}}
      ]

      assert Spatial.extreme(tied, :right) == "high"
    end
  end

  describe "direction/1 — the key after C-w" do
    test "hjkl and arrows map to the four directions" do
      assert Spatial.direction("h") == :left
      assert Spatial.direction("l") == :right
      assert Spatial.direction("k") == :up
      assert Spatial.direction("j") == :down
      assert Spatial.direction("left") == :left
      assert Spatial.direction("right") == :right
    end

    test "a non-direction key is nil (the leader cancels, no stray move)" do
      assert Spatial.direction("x") == nil
      assert Spatial.direction("enter") == nil
    end
  end
end
