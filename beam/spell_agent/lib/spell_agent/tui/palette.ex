defmodule SpellAgent.Tui.Palette do
  @moduledoc """
  The command palette's STATE + SELECTION logic (FEAT-047 W2).

  The palette is "a text buffer driving a filtered list + a cursor" — modeled as
  a THIRD modal layer held entirely in `ui.flags` (bounded by `Ui.safe_flags`,
  never-brick), NOT a new struct field. This module is the ONE place that reads
  and writes those flags, so no App code touches raw palette flags inline (the
  oracle gate's state-discipline requirement, agent 30):

    * `"palette"`        — `true` while open.
    * `"palette-query"`  — the filter string (binary, length-capped).
    * `"palette-cursor"` — the selection index into the FILTERED rows (int).

  All reads treat flags as UNTRUSTED: a non-binary query reads as `""`, a
  non-integer cursor as `0`, and the cursor is CLAMPED to the filtered-row bounds
  at read time — so a corrupt flag can never crash the render or fire a bad row.

  ## Firing

  A palette row carries a TRUSTED dispatch context term (`"dispatch-ctx"`, a
  module for a compiled context or a bare atom for a runtime one — set by
  `KeymapIntrospect`, never re-interned from a display string). `resolution/1`
  turns the selected row into a `{:intent, intent, ctx}` the App feeds to its
  shared `apply_intent/2` — the SAME path a real keystroke takes.
  """

  alias SpellAgent.Tui.Ui

  # Cap on the filter string length — a palette query is a short filter, not a
  # document. Bounds the flag value independently of safe_flags' byte cap.
  @max_query 64

  @doc "Whether the palette is open (a strict boolean read)."
  @spec open?(Ui.t()) :: boolean()
  def open?(%Ui{flags: flags}), do: Map.get(flags, "palette", false) == true
  def open?(_), do: false

  @doc "Open the palette: set the flag, reset query + cursor. Bounded via safe_flags."
  @spec open(Ui.t()) :: Ui.t()
  def open(%Ui{} = ui) do
    put_flags(ui, %{"palette" => true, "palette-query" => "", "palette-cursor" => 0})
  end

  @doc "Close the palette: clear every palette flag."
  @spec close(Ui.t()) :: Ui.t()
  def close(%Ui{flags: flags} = ui) do
    cleaned =
      flags
      |> Map.drop(["palette", "palette-query", "palette-cursor"])

    %{ui | flags: Ui.safe_flags(cleaned) || %{}}
  end

  @doc "The current filter query (untrusted → `\"\"` if not a binary)."
  @spec query(Ui.t()) :: String.t()
  def query(%Ui{flags: flags}) do
    case Map.get(flags, "palette-query") do
      q when is_binary(q) -> q
      _ -> ""
    end
  end

  @doc "Append a character to the query (capped at @max_query)."
  @spec append(Ui.t(), String.t()) :: Ui.t()
  def append(%Ui{} = ui, ch) when is_binary(ch) do
    next = String.slice(query(ui) <> ch, 0, @max_query)
    # Editing the query resets the cursor to the top of the new result set.
    put_flags(ui, %{"palette-query" => next, "palette-cursor" => 0})
  end

  @doc "Delete the last query character (backspace)."
  @spec backspace(Ui.t()) :: Ui.t()
  def backspace(%Ui{} = ui) do
    next = String.slice(query(ui), 0, max(String.length(query(ui)) - 1, 0))
    put_flags(ui, %{"palette-query" => next, "palette-cursor" => 0})
  end

  @doc """
  The raw cursor index (untrusted → 0 if not an integer). NOT clamped — use
  `selected_index/2` for the render/fire-safe clamped value against real rows.
  """
  @spec cursor(Ui.t()) :: integer()
  def cursor(%Ui{flags: flags}) do
    case Map.get(flags, "palette-cursor") do
      c when is_integer(c) -> c
      _ -> 0
    end
  end

  @doc "Move the cursor by `delta` (clamped to `0..count-1` against `rows`)."
  @spec move(Ui.t(), [map()], integer()) :: Ui.t()
  def move(%Ui{} = ui, rows, delta) when is_list(rows) do
    filtered = filter(rows, query(ui))
    next = clamp(cursor(ui) + delta, length(filtered))
    put_flags(ui, %{"palette-cursor" => next})
  end

  @doc "The clamped selection index into the FILTERED rows (render + fire safe)."
  @spec selected_index(Ui.t(), [map()]) :: non_neg_integer()
  def selected_index(%Ui{} = ui, rows) when is_list(rows) do
    clamp(cursor(ui), length(filter(rows, query(ui))))
  end

  def selected_index(_ui, _rows), do: 0

  @doc """
  The rows matching the current query, in order. A row matches if its chord,
  label, intent, or context contains the (lowercased) query as a substring. An
  empty query matches everything. Total: non-map rows are dropped.
  """
  @spec filter([map()], String.t()) :: [map()]
  def filter(rows, q) when is_list(rows) and is_binary(q) do
    needle = q |> String.trim() |> String.downcase()

    rows
    |> Enum.filter(&is_map/1)
    |> Enum.filter(fn row ->
      needle == "" or String.contains?(haystack(row), needle)
    end)
  end

  def filter(_rows, _q), do: []

  @doc """
  The `{:intent, intent, ctx}` resolution for the currently-selected row, or
  `nil` if there is no valid selection (empty result set, or a malformed row
  without a usable intent/dispatch-ctx). The ctx is the row's TRUSTED
  `dispatch-ctx` term — never re-interned from a string.
  """
  @spec resolution(Ui.t(), [map()]) :: {:intent, atom(), module() | atom()} | nil
  def resolution(%Ui{} = ui, rows) when is_list(rows) do
    filtered = filter(rows, query(ui))
    idx = clamp(cursor(ui), length(filtered))

    case Enum.at(filtered, idx) do
      %{"intent" => intent_s, "dispatch-ctx" => ctx} when is_binary(intent_s) ->
        case safe_intent_atom(intent_s) do
          nil -> nil
          intent -> {:intent, intent, ctx}
        end

      _ ->
        nil
    end
  end

  def resolution(_ui, _rows), do: nil

  @doc "The query length cap (tests/introspection)."
  @spec max_query() :: pos_integer()
  def max_query, do: @max_query

  # ---- internals ----

  # The searchable text for a row: chord + label + intent + context, lowercased.
  defp haystack(row) do
    [
      Map.get(row, "chord", ""),
      Map.get(row, "label", ""),
      Map.get(row, "intent", ""),
      Map.get(row, "context", "")
    ]
    |> Enum.map(&to_string/1)
    |> Enum.join(" ")
    |> String.downcase()
  end

  # Clamp `i` into `0..count-1`; an empty set clamps to 0.
  defp clamp(_i, 0), do: 0
  defp clamp(i, _count) when i < 0, do: 0
  defp clamp(i, count) when i >= count, do: count - 1
  defp clamp(i, _count), do: i

  # An intent string → its atom, but ONLY if the atom already exists (every
  # bound intent is interned at keymap-compile time via
  # `KeymapRegistry.define_intent`/compiled keymaps). A display string that maps
  # to no existing intent atom yields nil (no atom-table growth from a fired
  # row) — defense in depth even though rows come from our own reflection.
  defp safe_intent_atom(s) do
    String.to_existing_atom(s)
  rescue
    ArgumentError -> nil
  end

  # Write a set of palette flags through the bounded safe_flags chokepoint.
  defp put_flags(%Ui{flags: flags} = ui, updates) do
    %{ui | flags: Ui.safe_flags(Map.merge(flags, updates)) || flags}
  end
end
