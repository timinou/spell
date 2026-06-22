defmodule SpellAgent.Tui.Sanitize do
  @moduledoc """
  The capability-boundary deep-strip for any term that crosses into `data/*`
  (PLAN-012 W3 review #1, extracted at PROJ-004 W0r so the data-bag host and the
  reactive-cell host share ONE implementation).

  ## Why it exists

  A `tmpl::` hole and a reactive cell both evaluate against `data/*` — the hole
  with no tools, the cell with a read-only tier. But PTC can still CALL any
  function value reachable from the context, and a granted read-only tool can
  RETURN any BEAM term (a function, a pid, a struct carrying a live callback). If
  such a term reached `data/*`, a later no-tools hole could invoke it in function
  position — smuggling an executable capability past the render-purity boundary
  ("looking never acts").

  `term/1` deep-strips every non-serializable term — functions, pids, refs, ports
  -> `nil`; structs -> plain string-keyed maps (the `__struct__` tag dropped, no
  module/behaviour leak); MapSets/lists/tuples/maps recursed. What remains is pure
  data a hole can only READ. This is the single source of truth for that contract:
  `DataBag.build/2` strips the whole bag; `Cell` strips each resolved value before
  it is merged in.
  """

  @doc """
  Deep-strip `term` to pure, non-executable data.

  Functions/pids/refs/ports -> `nil`; structs -> string-keyed maps; collections
  recurse. Total — never raises.
  """
  @spec term(term()) :: term()
  def term(t) when is_function(t), do: nil
  def term(t) when is_pid(t) or is_reference(t) or is_port(t), do: nil

  def term(%MapSet{} = set),
    do: set |> MapSet.to_list() |> Enum.map(&term/1) |> MapSet.new()

  def term(%_{} = struct) do
    # A struct (e.g. a Span) -> a plain string-keyed map with each field stripped,
    # dropping the __struct__ tag so no module/behaviour leaks and the result is
    # pure data a hole can only read.
    struct
    |> Map.from_struct()
    |> Map.new(fn {k, v} -> {string_key(k), term(v)} end)
  end

  def term(map) when is_map(map),
    do: Map.new(map, fn {k, v} -> {key(k), term(v)} end)

  def term(list) when is_list(list), do: Enum.map(list, &term/1)
  def term(tuple) when is_tuple(tuple), do: tuple |> Tuple.to_list() |> Enum.map(&term/1)
  def term(other), do: other

  @doc """
  Coerce a map key to a stable scalar.

  Map keys must stay scalar (a stripped fn-key would collide on `nil`); atoms ->
  strings, binaries/integers kept, anything else -> its inspected form.
  """
  @spec key(term()) :: String.t() | integer()
  def key(k) when is_binary(k) or is_integer(k), do: k
  def key(k) when is_atom(k) and not is_nil(k), do: Atom.to_string(k)
  def key(k), do: inspect(k)

  # Struct field names are always atoms; coerce to string for the plain-map form.
  defp string_key(k) when is_atom(k), do: Atom.to_string(k)
  defp string_key(k), do: key(k)
end
