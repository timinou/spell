defmodule SpellAgent.Tui.Reflect do
  @moduledoc """
  The no-drift engine (PLAN-009): a COMPILE-TIME registry of every ex_ratatui
  widget/leaf struct + the Theme palette, derived purely by reflection.

  The whole freeform-TUI thesis rests here. ex_ratatui's NIF boundary already
  turns each `%Widget{}` struct into a string-keyed map (see
  `ExRatatui.Bridge.encode_widget/1`); PTC-Lisp emits string-keyed maps natively.
  So the gap between "what a PTC program produces" and "what the renderer
  consumes" is a single reflected coercion — NOT a hand-written binding per
  widget. This module is the reflection: it reads ex_ratatui's own struct shapes
  and exposes them as data the `view/` builders, `Materialize`, and the prelude
  all consume.

  Because the registry is DERIVED, adding a widget or field upstream makes it
  appear in the PTC surface and the generated prelude automatically — no drift,
  no magic, no per-widget code.

  ## What is reflected

    * every `ExRatatui.Widgets.*` and `ExRatatui.Text.*` module that defines a
      struct (the renderable leaves + rich-text primitives + Block + Block.Title),
    * `ExRatatui.Style` (the universal style leaf), and
    * `ExRatatui.Theme` (the named-slot palette — Edge T, in v1).

  For each, the registry records `{name => %{module, fields, defaults}}` where
  `name` is the snake_case wire name (`"bar_chart"`), `fields` are the struct's
  keys, and `defaults` is the struct's default map. `Materialize` reads
  `defaults` to decide per-field coercion (an atom default => enum, a struct
  default => recurse, a tuple default => list->tuple), so coercion stays
  reflection-driven rather than a hand-maintained per-field table.

  ## Compile-time, not runtime

  The scan runs ONCE at compile (`Application.spec/2` reads the dep's `.app`
  module list; the dep is built before us), frozen into module attributes. No
  per-call reflection, no app-load dependency at runtime.
  """

  # ---- compile-time scan ----
  #
  # NB: everything here runs at COMPILE time as module-attribute evaluation, so it
  # cannot call this module's own functions (the module isn't compiled yet). The
  # predicates are therefore inline anonymous fns bound before the comprehension.

  # ex_ratatui's modules, from its .app spec (available at compile: the dep is
  # compiled before this app). Filtered to the struct-bearing leaves we expose.
  @ex_ratatui_modules (case Application.spec(:ex_ratatui, :modules) do
                         mods when is_list(mods) -> mods
                         _ -> []
                       end)

  # A module is a reflectable leaf iff it lives under Widgets./Text. (or is
  # Style/Theme/Block) AND defines a struct. Code.ensure_compiled? forces the dep
  # module loadable so struct/1 works at compile time.
  @leaf? fn mod ->
    name = Atom.to_string(mod)

    (String.starts_with?(name, "Elixir.ExRatatui.Widgets.") or
       String.starts_with?(name, "Elixir.ExRatatui.Text.") or
       mod in [ExRatatui.Style, ExRatatui.Theme, ExRatatui.Widgets.Block]) and
      match?({:module, _}, Code.ensure_compiled(mod)) and
      function_exported?(mod, :__struct__, 0)
  end

  # Wire name: snake_case of the meaningful module tail under Widgets/Text. So
  # "BarChart" -> "bar_chart" and ["Block","Title"] -> "block_title" (the parent is
  # kept so Block.Title doesn't collide with a hypothetical Title leaf).
  @wire_name fn mod ->
    mod
    |> Module.split()
    |> Enum.drop_while(&(&1 in ~w(ExRatatui Widgets Text)))
    |> Enum.map_join("_", &Macro.underscore/1)
  end

  @registry (for mod <- @ex_ratatui_modules, @leaf?.(mod), into: %{} do
               defaults = mod |> struct() |> Map.from_struct()

               {@wire_name.(mod),
                %{
                  module: mod,
                  fields: Map.keys(defaults),
                  defaults: defaults
                }}
             end)

  # The Theme palette's slot names (the named colors apps thread through render).
  # Reflected from the Theme struct so a new slot upstream appears automatically.
  @theme_slots ExRatatui.Theme
               |> struct()
               |> Map.from_struct()
               |> Map.keys()

  # ---- enum-atom harvest (the existing-atom coercion's prerequisite) ----
  #
  # Materialize coerces enum field strings ("rounded", "bottom_to_top") via
  # String.to_existing_atom — which only works if the atom is INTERNED. An enum
  # value that is never a struct default (e.g. :rounded; the default is :plain)
  # may not be interned at runtime, so the coercion would fall back to the default
  # and silently drop the agent's choice.
  #
  # Fix, in keeping with the no-drift thesis: the enum VOCABULARY lives in
  # ex_ratatui's own @type specs (`@type border_type :: :plain | :rounded | ...`).
  # Harvest every atom literal from each reflected module's typespecs at COMPILE
  # time and freeze them into a module attribute. Referencing that attribute's
  # contents at runtime guarantees the atoms exist — no hand-listed enum tables,
  # and a new enum value upstream is interned automatically.
  @enum_atoms (for {_name, %{module: mod}} <- @registry,
                   reduce: MapSet.new() do
                 acc ->
                   case Code.Typespec.fetch_types(mod) do
                     {:ok, types} ->
                       Enum.reduce(types, acc, fn {_kind, {_n, def, _args}}, a ->
                         collect = fn
                           {:atom, _, atom}, set when is_atom(atom) -> MapSet.put(set, atom)
                           _node, set -> set
                         end

                         # Walk the erlang typespec form collecting :atom literals.
                         do_walk = fn do_walk, node, set ->
                           set = collect.(node, set)

                           cond do
                             is_tuple(node) ->
                               Enum.reduce(Tuple.to_list(node), set, &do_walk.(do_walk, &1, &2))

                             is_list(node) ->
                               Enum.reduce(node, set, &do_walk.(do_walk, &1, &2))

                             true ->
                               set
                           end
                         end

                         do_walk.(do_walk, def, a)
                       end)

                     _ ->
                       acc
                   end
               end)
              |> MapSet.to_list()

  # ---- struct-typed field harvest (the nilable-struct-field fix, BUG-008) ----
  #
  # `Materialize` decides whether to recurse a nested map into a struct by looking
  # at the field's DEFAULT value's `__struct__`. That works for `:style` on
  # Paragraph/Block (default `%Style{}`), but FAILS for a NILABLE struct field —
  # Sparkline's `:style` defaults to `nil`, so the default reveals no type and the
  # raw agent map passes straight through to the Bridge, which raises
  # (`expected %ExRatatui.Style{}, got: %{...}`) and the whole frame is dropped.
  #
  # The type IS knowable: it lives in the struct's `@type t` spec as a
  # `remote_type` (e.g. `style: ExRatatui.Style.t() | nil`). Harvest, per module,
  # a `field => struct_module` map at COMPILE time (same mechanism as the enum
  # harvest), so Materialize can coerce a typeless nested map to the right struct
  # regardless of the default. No drift: a new struct field upstream is picked up
  # automatically.
  @struct_field_walk fn walk, node ->
    case node do
      # A remote `Mod.t()` reference -> that module is the field's struct type.
      {:remote_type, _, [{:atom, _, mod}, {:atom, _, :t}, _]} when is_atom(mod) ->
        mod

      tuple when is_tuple(tuple) ->
        Enum.find_value(Tuple.to_list(tuple), fn child -> walk.(walk, child) end)

      list when is_list(list) ->
        Enum.find_value(list, fn child -> walk.(walk, child) end)

      _ ->
        nil
    end
  end

  @field_structs (for {name, %{module: mod}} <- @registry, into: %{} do
                    pairs =
                      case Code.Typespec.fetch_types(mod) do
                        {:ok, types} ->
                          fields =
                            for {_kind, {:t, def, _args}} <- types,
                                {:type, _, :map_field_exact, [{:atom, _, field}, ftype]} <-
                                  (case def do
                                     {:type, _, :map, entries} when is_list(entries) -> entries
                                     _ -> []
                                   end),
                                struct_mod = @struct_field_walk.(@struct_field_walk, ftype),
                                not is_nil(struct_mod),
                                into: %{} do
                              {field, struct_mod}
                            end

                          fields

                        _ ->
                          %{}
                      end

                    {name, pairs}
                  end)

  # Reverse index: module => wire name, for any code holding a struct.
  @by_module for {name, %{module: mod}} <- @registry, into: %{}, do: {mod, name}

  # ---- public API ----

  @typedoc "A reflected leaf descriptor."
  @type entry :: %{module: module(), fields: [atom()], defaults: map()}

  @doc "The full registry: wire name => `%{module, fields, defaults}`."
  @spec registry() :: %{optional(String.t()) => entry()}
  def registry, do: @registry

  @doc "The reflected leaf entry for a wire name, or `:error`."
  @spec fetch(String.t()) :: {:ok, entry()} | :error
  def fetch(name) when is_binary(name), do: Map.fetch(@registry, name)

  @doc "The module a wire name maps to, or nil."
  @spec module_for(String.t()) :: module() | nil
  def module_for(name) when is_binary(name) do
    case Map.fetch(@registry, name) do
      {:ok, %{module: mod}} -> mod
      :error -> nil
    end
  end

  @doc "The wire name for a struct module, or nil."
  @spec name_for(module()) :: String.t() | nil
  def name_for(mod) when is_atom(mod), do: Map.get(@by_module, mod)

  @doc "All reflected wire names, sorted."
  @spec names() :: [String.t()]
  def names, do: @registry |> Map.keys() |> Enum.sort()

  @doc "The struct's default map for a wire name (drives Materialize coercion)."
  @spec defaults(String.t()) :: map() | nil
  def defaults(name) when is_binary(name) do
    case Map.fetch(@registry, name) do
      {:ok, %{defaults: d}} -> d
      :error -> nil
    end
  end

  @doc "The Theme palette slot names (reflected from `ExRatatui.Theme`)."
  @spec theme_slots() :: [atom()]
  def theme_slots, do: @theme_slots

  @doc """
  The struct-typed fields of a wire name: `field => struct_module`, harvested from
  the struct's `@type t` spec (so NILABLE struct fields like Sparkline's `:style`
  are still known despite a `nil` default). Drives Materialize's coercion of a
  bare nested map (e.g. `style: %{fg: ...}`) into the right struct. Empty map for
  an unknown name or a struct with no struct-typed fields.
  """
  @spec field_structs(String.t()) :: %{optional(atom()) => module()}
  def field_structs(name) when is_binary(name), do: Map.get(@field_structs, name, %{})

  @doc """
  Every enum atom harvested from the reflected modules' typespecs (border types,
  alignments, directions, colors, modifiers, ...). Referencing this guarantees the
  atoms are interned, which is the precondition for Materialize's existing-atom
  coercion to recognise an enum string the agent writes.
  """
  @spec enum_atoms() :: [atom()]
  def enum_atoms, do: @enum_atoms

  # Force the harvested enum atoms to be interned at module load (belt-and-braces:
  # the literal list in the compiled beam already interns them, but an explicit
  # reference documents the intent and survives any future literal-stripping).
  @doc false
  def __intern_enums__, do: length(@enum_atoms)
end
