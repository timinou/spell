defmodule SpellAgent.Tui.Palette do
  @moduledoc """
  The command palette's STATE + SELECTION logic (FEAT-047 W2, hardened post-audit).

  ## Where this state lives, and why (the thing the audit actually found)

  Palette state — open?, the typed query, the cursor — used to live in
  `ui.flags`. That was wrong, and not just mechanically (the 32-entry
  `Ui.safe_flags` cap could evict it under load) — CATEGORICALLY wrong.
  `ui.flags` is the MIND's extension point: `Reaction.Ptc.rehydrate/2`
  round-trips exactly ten named gaze fields and then hands `flags` back
  UNTOUCHED as the place "a reaction... carries NOVEL state... beyond the ten
  fixed fields" (see `reaction/ptc.ex`). It exists so an agent-authored PTC
  program can stash its own data across keystrokes. It is bounded at 32 entries
  precisely BECAUSE it is agent-writable and therefore adversarial-by-design.

  The palette is not that. It is App-internal input mechanism — the same kind
  of thing as `pending_leader` (armed by `C-w`, cleared by the next key), which
  has ALWAYS lived as a sibling field on the App's `state`, never inside `Ui`.
  Palette state is trusted (only the App itself writes it, in direct response to
  a keystroke), inherently bounded (one boolean, one capped string, one
  clamped integer — never grows), and has a clean lifecycle (open → closed).
  Putting it in the agent-writable bag was a category error: trusted,
  App-owned UI state wearing the untrusted-extension-point's badge. The fix is
  not a bigger cap — it is the CORRECT drawer: `state.palette`, a `%Palette{}`
  struct, a sibling of `pending_leader`, that `ui.flags` and its eviction policy
  never see and can never touch.

  ## Shape

    * `open?`   — `true` while the palette owns the keyboard.
    * `query`   — the filter string (capped at `@max_query` UNCONDITIONALLY —
      every constructor here returns an already-clamped value, so there is no
      "read path" that could see an unclamped one).
    * `cursor`  — the selection index into the FILTERED rows, clamped to
      `0..count-1` at every read (`selected_index/2`), so a stale value after
      the query narrows can never point past the end.

  ## Firing

  A palette row carries a TRUSTED dispatch context term (`"dispatch-ctx"`, a
  module for a compiled context or a bare atom for a runtime one — set by
  `KeymapIntrospect`, never re-interned from a display string). `resolution/2`
  turns the selected row into a `{:intent, intent, ctx}` the App feeds to its
  shared `apply_intent/2` — the SAME path a real keystroke takes. Guarded so a
  MALFORMED live row (a `dispatch-ctx` that isn't an atom — e.g. a bad
  `data/keybindings` producer) degrades to `nil` (no fire) instead of crashing
  `Keys.context_name/1` deeper in the dispatch path (this was the audit's
  Manipura finding: only the palette could hand a non-atom context in).
  """

  @typedoc "Palette modal state — App-owned, never mind-writable."
  @type t :: %__MODULE__{open?: boolean(), query: String.t(), cursor: non_neg_integer()}

  defstruct open?: false, query: "", cursor: 0

  # Cap on the filter string length — a palette query is a short filter, not a
  # document. Every constructor below enforces this; there is no bypass.
  @max_query 64

  @doc "A closed palette (the App's initial/reset state)."
  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc "Whether the palette is open."
  @spec open?(t()) :: boolean()
  def open?(%__MODULE__{open?: v}), do: v == true
  def open?(_), do: false

  @doc "Open the palette: reset query + cursor to a clean slate."
  @spec open(t()) :: t()
  def open(%__MODULE__{} = p), do: %{p | open?: true, query: "", cursor: 0}
  def open(_), do: open(new())

  @doc "Close the palette: clear query + cursor along with the open flag."
  @spec close(t()) :: t()
  def close(%__MODULE__{} = _p), do: new()
  def close(_), do: new()

  @doc "The current filter query (always already-clamped; total on any input)."
  @spec query(t()) :: String.t()
  def query(%__MODULE__{query: q}) when is_binary(q), do: q
  def query(_), do: ""

  @doc "Append a character to the query (capped at @max_query)."
  @spec append(t(), String.t()) :: t()
  def append(%__MODULE__{} = p, ch) when is_binary(ch) do
    next = String.slice(query(p) <> ch, 0, @max_query)
    # Editing the query resets the cursor to the top of the new result set.
    %{p | query: next, cursor: 0}
  end

  def append(p, _ch), do: p

  @doc "Delete the last query character (backspace)."
  @spec backspace(t()) :: t()
  def backspace(%__MODULE__{} = p) do
    q = query(p)
    %{p | query: String.slice(q, 0, max(String.length(q) - 1, 0)), cursor: 0}
  end

  def backspace(p), do: p

  @doc "The raw cursor index. NOT clamped — use `selected_index/2` for reads."
  @spec cursor(t()) :: integer()
  def cursor(%__MODULE__{cursor: c}) when is_integer(c), do: c
  def cursor(_), do: 0

  @doc "Move the cursor by `delta` (clamped to `0..count-1` against `rows`)."
  @spec move(t(), [map()], integer()) :: t()
  def move(%__MODULE__{} = p, rows, delta) when is_list(rows) and is_integer(delta) do
    filtered = filter(rows, query(p))
    %{p | cursor: clamp(cursor(p) + delta, length(filtered))}
  end

  def move(p, _rows, _delta), do: p

  @doc "The clamped selection index into the FILTERED rows (render + fire safe)."
  @spec selected_index(t(), [map()]) :: non_neg_integer()
  def selected_index(%__MODULE__{} = p, rows) when is_list(rows) do
    clamp(cursor(p), length(filter(rows, query(p))))
  end

  def selected_index(_p, _rows), do: 0

  @doc """
  The rows matching the current query, in order. A row matches if its chord,
  label, intent, or context contains the (lowercased) query as a substring. An
  empty query matches everything. Total: non-map rows, and rows whose fields
  aren't plain strings, are normalized to "" for matching rather than raised —
  a live `data/keybindings` producer is untrusted input, not our own data.
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
  `nil` if there is no valid selection (empty result set, a malformed row, or a
  row whose `dispatch-ctx` isn't an atom — a live producer cannot forge a
  context that would otherwise reach `Keys.context_name/1`, which is atom-only
  and would raise). The ctx is the row's TRUSTED `dispatch-ctx` term — never
  re-interned from a string.
  """
  @spec resolution(t(), [map()]) :: {:intent, atom(), module() | atom()} | nil
  def resolution(%__MODULE__{} = p, rows) when is_list(rows) do
    filtered = filter(rows, query(p))
    idx = clamp(cursor(p), length(filtered))

    case Enum.at(filtered, idx) do
      %{"intent" => intent_s, "dispatch-ctx" => ctx}
      when is_binary(intent_s) and is_atom(ctx) ->
        case safe_intent_atom(intent_s) do
          nil -> nil
          intent -> {:intent, intent, ctx}
        end

      _ ->
        nil
    end
  end

  def resolution(_p, _rows), do: nil

  @doc "The query length cap (tests/introspection)."
  @spec max_query() :: pos_integer()
  def max_query, do: @max_query

  # ---- internals ----

  # The searchable text for a row: chord + label + intent + context, lowercased.
  # A field that isn't a plain string (a live producer could emit anything) is
  # normalized to "" rather than passed to `to_string/1`, which would raise on a
  # map/tuple (the audit's Third Eye finding) — untrusted shape, defused here.
  defp haystack(row) do
    [str_field(row, "chord"), str_field(row, "label"), str_field(row, "intent"), str_field(row, "context")]
    |> Enum.join(" ")
    |> String.downcase()
  end

  defp str_field(row, key) do
    case Map.get(row, key) do
      v when is_binary(v) -> v
      v when is_atom(v) and not is_nil(v) -> Atom.to_string(v)
      v when is_integer(v) -> Integer.to_string(v)
      _ -> ""
    end
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
end
