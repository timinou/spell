defmodule SpellAgent.Tui.Chord do
  @moduledoc """
  A normalized keystroke (PLAN-346) — the atom of the Reaction DSL's input side.

  A `%Chord{}` is the canonical, comparable form of a key press: a base `key`
  plus a SORTED set of `mods`. Two surfaces map onto it:

    * `from_event/1` — the live `%ExRatatui.Event.Key{}` (whose `modifiers` are
      strings like `"ctrl"`). NB the App today matches `code in ["ctrl-c"]`, which
      is DEAD — the parser emits ctrl-c as `code: "c", modifiers: ["ctrl"]`. Reading
      `modifiers` here is what makes ctrl-chords actually resolvable.
    * `parse/1` — the human/DSL surface string `"C-j"`, `"C-S-tab"`, `"esc"`.

  `mods` is always sorted (`[:alt, :ctrl, :shift]` order) so structurally-equal
  chords are `==`-equal and usable as map keys in the keymap registry — the whole
  resolver leans on this.

  Engine name, plainly (PLAN-346 D2): Chord. No flavor.
  """

  @typedoc "A modifier key. Ordered alt < ctrl < shift for canonical sorting."
  @type mod :: :alt | :ctrl | :shift

  @type t :: %__MODULE__{key: String.t(), mods: [mod()]}

  @enforce_keys [:key]
  defstruct key: nil, mods: []

  # Canonical sort order for mods so equal chords compare equal.
  @mod_order %{alt: 0, ctrl: 1, shift: 2}

  @doc """
  Build a Chord from a live ExRatatui key event.

  Reads `code` as the base key and maps `modifiers` (strings) to mod atoms,
  dropping any we don't model (`super`/`hyper`/`meta`) so they don't break
  equality with a `parse/1`-built chord. The result's `mods` is sorted.

      iex> Chord.from_event(%ExRatatui.Event.Key{code: "j", modifiers: ["ctrl"]})
      %Chord{key: "j", mods: [:ctrl]}
  """
  @spec from_event(ExRatatui.Event.Key.t()) :: t()
  def from_event(%ExRatatui.Event.Key{code: code, modifiers: mods}) do
    %__MODULE__{key: code, mods: normalize_mods(Enum.map(mods, &mod_from_string/1))}
  end

  @doc """
  Parse the DSL surface string into a Chord.

  Grammar: zero or more single-letter modifier sigils, then the key, all joined
  by `-`. Sigils: `C` = ctrl, `M` = alt (meta), `S` = shift. The key is whatever
  follows the last `-` (so a bare `"-"` or `"C--"` keys the literal `-`).

      iex> Chord.parse("C-j")     #=> %Chord{key: "j", mods: [:ctrl]}
      iex> Chord.parse("C-S-tab") #=> %Chord{key: "tab", mods: [:ctrl, :shift]}
      iex> Chord.parse("esc")     #=> %Chord{key: "esc", mods: []}
  """
  @spec parse(String.t()) :: t()
  def parse(s) when is_binary(s) do
    cond do
      # Empty string is never a valid chord.
      s == "" ->
        raise ArgumentError, "malformed chord #{inspect(s)}: empty string"

      # The bare literal-hyphen key.
      s == "-" ->
        %__MODULE__{key: "-", mods: []}

      # A literal-hyphen key WITH modifiers ends in "--" ("C--", "C-M--"): strip
      # the trailing "--", the remainder are sigils.
      String.ends_with?(s, "--") ->
        sigils = s |> String.slice(0..-3//1) |> String.split("-", trim: true)
        %__MODULE__{key: "-", mods: normalize_mods(Enum.map(sigils, &mod_from_sigil/1))}

      # A single trailing "-" with a non-hyphen key is a typo ("C-", "esc-"): the
      # key is empty. Fail loud rather than silently binding the hyphen — the
      # keymap/1 macro parses at compile time, so a bad binding crashes the build.
      String.ends_with?(s, "-") ->
        raise ArgumentError, "malformed chord #{inspect(s)}: empty key"

      true ->
        parts = String.split(s, "-")
        {sigils, [last]} = Enum.split(parts, -1)
        %__MODULE__{key: last, mods: normalize_mods(Enum.map(sigils, &mod_from_sigil/1))}
    end
  end

  @doc """
  Render a Chord back to its DSL surface string (round-trips with `parse/1`).

      iex> Chord.to_string(%Chord{key: "j", mods: [:ctrl]}) #=> "C-j"
  """
  @spec to_string(t()) :: String.t()
  def to_string(%__MODULE__{key: key, mods: mods}) do
    Enum.map_join(normalize_mods(mods), "", &(sigil_for(&1) <> "-")) <> key
  end

  # ---- helpers ----

  # Sort + dedup mods into canonical order; drop unmodeled atoms (nil).
  defp normalize_mods(mods) do
    mods
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
    |> Enum.sort_by(&Map.fetch!(@mod_order, &1))
  end

  defp mod_from_string("ctrl"), do: :ctrl
  defp mod_from_string("alt"), do: :alt
  defp mod_from_string("shift"), do: :shift
  # super / hyper / meta and anything unknown: unmodeled, dropped.
  defp mod_from_string(_), do: nil

  defp mod_from_sigil("C"), do: :ctrl
  defp mod_from_sigil("M"), do: :alt
  defp mod_from_sigil("S"), do: :shift
  defp mod_from_sigil(other), do: raise(ArgumentError, "unknown chord modifier sigil #{inspect(other)}")

  defp sigil_for(:ctrl), do: "C"
  defp sigil_for(:alt), do: "M"
  defp sigil_for(:shift), do: "S"
end
