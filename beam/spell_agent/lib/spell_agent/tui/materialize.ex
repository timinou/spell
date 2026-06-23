defmodule SpellAgent.Tui.Materialize do
  @moduledoc """
  PTC map -> `%Widget{}` struct (PLAN-009) — the thin coercion that lets a PTC
  program's plain string-keyed map become a real ex_ratatui struct, which then
  flows through the EXISTING `ExRatatui.Bridge` path unchanged (keeping all of
  Bridge's validation, text coercion, and custom-widget expansion).

  ## The reflection trick (no per-widget code)

  A PTC leaf is `%{"type" => "paragraph", "text" => ..., "style" => ...}`. The
  `"type"` selects a `Reflect` entry (module + field defaults). Each remaining
  key becomes a struct field, COERCED by a rule read from that field's DEFAULT
  value in the struct — the default tells you the type:

    * default is a struct (e.g. `%Style{}`, `%Block{}`) -> the value is a nested
      PTC map; recurse via its own `"type"` (or, for a bare `:style`/`:block`
      without a `"type"`, the field default's module).
    * default is a non-nil atom (e.g. `:left`, `:rounded`, `:top_to_bottom`) ->
      the value is an enum string; coerce to the EXISTING atom only
      (`String.to_existing_atom`, guarded — never interns; unknown -> dropped).
    * default is a tuple (e.g. `{0, 0}` scroll, `{0,0,0,0}` padding) -> the value
      is a PTC list; convert to a tuple.
    * default is a list whose elements look like enum atoms (`modifiers`,
      `borders`) -> map each element through the existing-atom coercion.
    * otherwise (string/int/bool/nil) -> pass through.

  `Style` carries the one genuinely special vocabulary (colors can be named atoms
  OR `{:rgb,r,g,b}` / `{:indexed,n}` maps), so its color fields get a dedicated
  coercion. Everything else is the generic rule above.

  ## Safety posture (experiment-first, PLAN-009 + FUP-007)

  Unknown widget `"type"` or unknown enum strings DEGRADE (drop the field / return
  an error tuple the caller's failure ladder catches) — never crash, never intern
  a new atom. Full atom-DoS hardening is FUP-007; this module already uses
  existing-atom-only coercion so it does not grow the atom table.
  """

  alias SpellAgent.Tui.Reflect

  @typedoc "A materialized widget struct, or an error the failure ladder catches."
  @type result :: struct() | {:error, term()}

  @doc """
  Coerce a PTC value into an ex_ratatui widget struct.

  Accepts a `%{"type" => name}` map (the common case). Returns the struct, or
  `{:error, reason}` for an unknown type / non-map (caught by the per-slot
  failure ladder). Already-built structs pass through (idempotent), so a native
  default expressed with real structs and an agent's PTC map compose uniformly.
  """
  @spec to_struct(term()) :: result()
  def to_struct(%{__struct__: _} = already), do: already

  def to_struct(map) when is_map(map) do
    case type_of(map) do
      nil ->
        {:error, {:no_type, Map.keys(map)}}

      name ->
        case Reflect.fetch(name) do
          {:ok, entry} -> build(entry, map)
          :error -> {:error, {:unknown_widget, name}}
        end
    end
  end

  def to_struct(other), do: {:error, {:not_a_widget, other}}

  # ---- build a struct from a reflected entry + the PTC map ----

  defp build(%{module: mod, defaults: defaults}, map) do
    # Struct-typed fields whose DEFAULT is nil (nilable struct fields like
    # Sparkline's `:style`) carry no type in their default, so coercion of a bare
    # nested map would pass it through raw -> Bridge crash. Reflect harvests the
    # field's struct type from the typespec; substitute an empty instance as the
    # coercion default so the typeless-map path recurses into the right struct.
    # (Only affects coercion of a PRESENT field; an ABSENT field keeps nil.)
    fstructs = Reflect.field_structs(Reflect.name_for(mod) || "")

    case fields(defaults, map, fstructs, mod) do
      {:ok, fields} -> struct(mod, fields)
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, {:materialize_failed, mod, Exception.message(e)}}
  end

  defp fields(defaults, map, fstructs, mod) do
    Enum.reduce_while(defaults, {:ok, %{}}, fn {field, default}, {:ok, acc} ->
      case fetch_field(map, field) do
        {:ok, raw} ->
          coerced = coerce(field, raw, coerce_default(default, field, fstructs), mod)

          case coerced do
            {:__field_error__, reason} -> {:halt, {:error, reason}}
            value -> {:cont, {:ok, Map.put(acc, field, value)}}
          end

        :error ->
          {:cont, {:ok, Map.put(acc, field, default)}}
      end
    end)
  end

  # The default value the coercion rule keys off. A real non-nil default is used
  # as-is; a nil default for a known struct-typed field is replaced by an empty
  # instance of that struct so a bare nested map coerces to it.
  defp coerce_default(nil, field, fstructs) do
    case Map.fetch(fstructs, field) do
      {:ok, struct_mod} -> struct(struct_mod)
      :error -> nil
    end
  end

  defp coerce_default(default, _field, _fstructs), do: default

  # ---- per-field coercion, rule chosen by the field's DEFAULT ----

  # Style is the one special vocabulary: its color fields accept named atoms OR
  # {:rgb,...}/{:indexed,...} maps, and its :modifiers are an enum list.
  defp coerce(field, raw, _default, ExRatatui.Style) when field in [:fg, :bg, :underline_color],
    do: coerce_color(raw)

  defp coerce(:modifiers, raw, _default, ExRatatui.Style) when is_list(raw),
    do: existing_atoms(raw)

  # A nested PTC map that carries its OWN resolvable "type" -> recurse, no matter
  # the field default. This is the robust signal (the default of a nilable struct
  # field like :block is `nil`, so the default alone can't tell us to recurse).
  # Covers :block ("type"=>"block"), nested widgets in :content/:children, spans.
  defp coerce(_field, raw, default, _parent)
       when is_map(raw) and not is_struct(raw) do
    if resolvable_type?(raw) do
      unwrap(to_struct(raw))
    else
      # No "type": only meaningful if the field default is itself a struct (the
      # ergonomic bare `:style {...}` case) — coerce to that module. Otherwise
      # pass the map through (Bridge handles text-ish maps).
      coerce_typeless_map(raw, default)
    end
  end

  # Already a struct in any slot -> pass through (idempotent compose).
  defp coerce(_field, %{__struct__: _} = raw, _default, _parent), do: raw

  # Boolean fields must stay boolean. Letting e.g. paragraph.wrap = "word" pass
  # through builds a struct but fails later in native draw, dropping every frame.
  # Reject at materialization so layout/set preserves last-good and can tell the
  # agent exactly which field is wrong.
  defp coerce(field, raw, default, parent) when is_boolean(default) do
    if is_boolean(raw) do
      raw
    else
      {:__field_error__,
       {:invalid_field, parent, field, :boolean, raw,
        "use true or false, or omit the field to keep the default"}}
    end
  end

  # A tuple-typed field (scroll {0,0}, padding {0,0,0,0}) <- a PTC list.
  defp coerce(_field, raw, default, _parent) when is_tuple(default) and is_list(raw),
    do: List.to_tuple(raw)

  # An enum-atom field (default is a non-nil atom, not boolean) <- an enum string.
  defp coerce(_field, raw, default, _parent)
       when is_atom(default) and default not in [nil, true, false],
       do: existing_atom(raw) || default

  # The genuine enum-LIST fields (atomize each element). ex_ratatui has exactly
  # two: :modifiers (handled under Style above) and :borders (Block). Every OTHER
  # list field is CONTENT (items, rows, data, children, spans, titles) and must
  # pass through untouched — a default of `[]` alone can't distinguish them, so we
  # name the enum-lists explicitly. (A typespec-driven classification is FUP-007.)
  defp coerce(:borders, raw, _default, _parent) when is_list(raw),
    do: existing_atoms(raw)

  # Everything else (string/int/bool/nil, or a list of text for :items/:text)
  # passes through; Bridge handles text coercion downstream.
  defp coerce(_field, raw, _default, _parent), do: raw

  # A map is a nested widget iff it carries a "type" that Reflect knows.
  defp resolvable_type?(map) do
    case type_of(map) do
      nil -> false
      name -> match?({:ok, _}, Reflect.fetch(name))
    end
  end

  # A typeless nested map: coerce to the field-default's struct module when the
  # default is a struct (bare `:style {...}`), else pass through.
  defp coerce_typeless_map(raw, %{__struct__: mod}) do
    case Reflect.name_for(mod) do
      nil -> raw
      name -> unwrap(to_struct(Map.put(raw, "type", name)))
    end
  end

  defp coerce_typeless_map(raw, _default), do: raw

  # ---- color (Style's special vocabulary) ----

  defp coerce_color(nil), do: nil
  defp coerce_color(s) when is_binary(s), do: existing_atom(s)
  defp coerce_color(a) when is_atom(a), do: a

  defp coerce_color(%{} = m) do
    case fetch_field(m, :type) do
      {:ok, "rgb"} -> {:rgb, geti(m, :r), geti(m, :g), geti(m, :b)}
      {:ok, "indexed"} -> {:indexed, geti(m, :value)}
      _ -> nil
    end
  end

  defp coerce_color(_), do: nil

  # ---- helpers ----

  # The "type" tag of a PTC map (string or atom key).
  defp type_of(map) when is_map(map) do
    case fetch_field(map, :type) do
      {:ok, t} when is_binary(t) -> t
      {:ok, t} when is_atom(t) and not is_nil(t) -> Atom.to_string(t)
      _ -> nil
    end
  end

  # Fetch a field that may be string- or atom-keyed, presence-aware (a stored
  # false/nil survives — only ABSENCE under both keys is :error).
  defp fetch_field(map, field) when is_atom(field) do
    skey = Atom.to_string(field)

    cond do
      Map.has_key?(map, skey) -> {:ok, Map.get(map, skey)}
      Map.has_key?(map, field) -> {:ok, Map.get(map, field)}
      true -> :error
    end
  end

  defp geti(m, key) do
    case fetch_field(m, key) do
      {:ok, n} when is_integer(n) -> n
      _ -> 0
    end
  end

  # Coerce to an EXISTING atom only (never interns). Strings that name no existing
  # atom -> nil (the caller substitutes the field default). This is the atom-DoS
  # chokepoint: a PTC program can only ever name atoms ex_ratatui already defined.
  defp existing_atom(s) when is_binary(s) do
    String.to_existing_atom(s)
  rescue
    ArgumentError -> nil
  end

  defp existing_atom(a) when is_atom(a), do: a
  defp existing_atom(_), do: nil

  defp existing_atoms(list) when is_list(list),
    do: list |> Enum.map(&existing_atom/1) |> Enum.reject(&is_nil/1)

  # Unwrap a nested to_struct result: a failed nested coercion bubbles as the
  # field default's absence (nil) rather than poisoning the parent — the parent
  # render still succeeds with a sane field.
  defp unwrap(%{__struct__: _} = s), do: s
  defp unwrap({:error, _}), do: nil
end
