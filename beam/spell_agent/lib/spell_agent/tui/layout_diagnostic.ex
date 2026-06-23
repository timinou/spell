defmodule SpellAgent.Tui.LayoutDiagnostic do
  @moduledoc """
  Path-aware validation for agent-authored layout nodes.

  `Surface.layout/2` intentionally degrades malformed subtrees to gaps so the live
  frame never bricks. `layout/set`, however, is an authoring surface: a rejected
  node must tell the agent which source path failed and why. This module mirrors
  the render probe with diagnostics instead of booleans.
  """

  alias ExRatatui.Layout
  alias ExRatatui.Layout.Rect
  alias SpellAgent.Tui.{Materialize, Surface}

  @type diagnostic :: %{
          required(String.t()) => term()
        }

  @probe_rect %Rect{x: 0, y: 0, width: 80, height: 24}

  @doc "Validate that a layout source produces encodable leaves."
  @spec validate(term()) :: :ok | {:error, diagnostic()}
  def validate(node) do
    with {:ok, resolved} <- resolve_holes(node),
         {:ok, leaves} <- place(resolved, @probe_rect, "source") do
      case leaves do
        [] ->
          {:error,
           diagnostic(
             "source",
             "empty_layout",
             "layout produced no renderable leaves",
             "source must be a widget leaf, a pane, or a split with renderable children"
           )}

        leaves ->
          validate_leaves(leaves)
      end
    end
  end

  @doc "Human-readable one-line summary for a diagnostic map."
  @spec format(diagnostic()) :: String.t()
  def format(diag) when is_map(diag) do
    path = Map.get(diag, "path", "source")
    reason = Map.get(diag, "reason", "invalid_layout")
    detail = Map.get(diag, "detail", "layout source is invalid")
    expected = Map.get(diag, "expected")

    base = "#{path}: #{reason}: #{detail}"

    if is_binary(expected) and expected != "" do
      base <> "; expected " <> expected
    else
      base
    end
  end

  # ---- resolving ----

  defp resolve_holes(node) do
    {:ok, Surface.resolve_holes(node, %{})}
  rescue
    e ->
      {:error,
       diagnostic(
         "source",
         "hole_resolution_failed",
         Exception.message(e),
         "tmpl:: holes must degrade to renderable placeholder values during validation"
       )}
  catch
    kind, value ->
      {:error,
       diagnostic(
         "source",
         "hole_resolution_failed",
         Exception.format_banner(kind, value),
         "tmpl:: holes must degrade to renderable placeholder values during validation"
       )}
  end

  # ---- layout walk with paths ----

  defp place(node, %Rect{} = rect, path) when is_map(node) do
    case kind(node) do
      "split" -> place_split(node, rect, path)
      nil -> {:error, missing_type(path, node)}
      _leaf -> {:ok, [{node, rect, path}]}
    end
  rescue
    e -> {:error, layout_failed(path, Exception.message(e))}
  catch
    kind, value -> {:error, layout_failed(path, Exception.format_banner(kind, value))}
  end

  defp place(nodes, %Rect{} = rect, path) when is_list(nodes) do
    nodes
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {node, index}, {:ok, acc} ->
      case place(node, rect, path <> "[#{index}]") do
        {:ok, leaves} -> {:cont, {:ok, acc ++ leaves}}
        {:error, _} = error -> {:halt, error}
      end
    end)
  end

  defp place(_other, _rect, path) do
    {:error,
     diagnostic(
       path,
       "not_a_node",
       "layout node must be a map",
       "a map built by view/<widget>, view/split, or tmpl::"
     )}
  end

  defp place_split(node, rect, path) do
    children = get(node, "children")

    cond do
      not is_list(children) ->
        {:error,
         diagnostic(
           path <> ".children",
           "invalid_children",
           "split children must be a list",
           "a non-empty list of layout nodes"
         )}

      children == [] ->
        {:error,
         diagnostic(
           path <> ".children",
           "empty_children",
           "split has no children",
           "at least one renderable child node"
         )}

      true ->
        rects =
          rect
          |> Layout.split(
            direction(get(node, "dir")),
            constraints(children, get(node, "constraints")),
            split_opts(get(node, "opts"))
          )
          |> split_result()

        case rects do
          {:error, detail} ->
            {:error,
             diagnostic(
               path <> ".constraints",
               "split_failed",
               detail,
               "valid split constraints such as [\"length\", 3], [\"percentage\", 50], or [\"fill\", 1]"
             )}

          [] ->
            {:error,
             diagnostic(
               path <> ".constraints",
               "empty_split",
               "split produced no child rectangles",
               "constraints that allocate space to at least one child"
             )}

          rects ->
            children
            |> Enum.with_index()
            |> Enum.zip(rects)
            |> Enum.reduce_while({:ok, []}, fn {{child, index}, subrect}, {:ok, acc} ->
              case place(child, subrect, path <> ".children[#{index}]") do
                {:ok, leaves} -> {:cont, {:ok, acc ++ leaves}}
                {:error, _} = error -> {:halt, error}
              end
            end)
        end
    end
  end

  defp split_result(rects) when is_list(rects), do: rects
  defp split_result({:error, reason}), do: {:error, inspect(reason)}
  defp split_result(other), do: {:error, inspect(other)}

  # ---- leaf validation ----

  defp validate_leaves(leaves) do
    Enum.reduce_while(leaves, :ok, fn {node, rect, path}, :ok ->
      case validate_leaf(node, rect, path) do
        :ok -> {:cont, :ok}
        {:error, _} = error -> {:halt, error}
      end
    end)
  end

  defp validate_leaf(node, _rect, path) do
    case kind(node) do
      "pane" -> :ok
      _ -> validate_widget(node, path)
    end
  end

  defp validate_widget(node, path) do
    case Materialize.to_struct(node) do
      %{__struct__: _} = widget -> encodable(widget, path)
      {:error, reason} -> {:error, materialize_error(path, reason)}
      other -> {:error, materialize_error(path, {:not_a_widget, other})}
    end
  end

  defp encodable(widget, path) do
    ExRatatui.Bridge.encode_command({widget, @probe_rect})
    :ok
  rescue
    e ->
      {:error,
       diagnostic(
         path,
         "encode_failed",
         Exception.message(e),
         "widget fields that the ex_ratatui bridge can encode"
       )}
  catch
    kind, value ->
      {:error,
       diagnostic(
         path,
         "encode_failed",
         Exception.format_banner(kind, value),
         "widget fields that the ex_ratatui bridge can encode"
       )}
  end

  defp materialize_error(path, {:unknown_widget, name}) do
    diagnostic(
      path <> ".type",
      "unknown_widget",
      "unknown widget type #{inspect(name)}",
      "\"split\", \"pane\", or a reflected widget type built with view/<widget>"
    )
  end

  defp materialize_error(path, {:no_type, keys}) do
    diagnostic(
      path,
      "missing_type",
      "node has keys #{inspect(keys)} but no type",
      "a \"type\" field, usually supplied by view/<widget> or view/split"
    )
  end

  defp materialize_error(path, {:invalid_field, _mod, field, :boolean, raw, hint}) do
    diagnostic(
      path <> "." <> Atom.to_string(field),
      "invalid_field",
      "field #{field} expected boolean, got #{type_name(raw)} #{inspect(raw)}",
      "boolean (`true` or `false`); #{hint}",
      %{
        "field" => Atom.to_string(field),
        "expected_type" => "boolean",
        "actual_type" => type_name(raw),
        "actual_value" => inspect(raw),
        "hint" => hint
      }
    )
  end

  defp materialize_error(path, {:materialize_failed, mod, message}) do
    diagnostic(
      path,
      "materialize_failed",
      "#{inspect(mod)} failed to build: #{message}",
      "fields matching the reflected widget definition"
    )
  end

  defp materialize_error(path, reason) do
    diagnostic(
      path,
      "materialize_failed",
      inspect(reason),
      "a reflected widget node"
    )
  end

  defp missing_type(path, node) do
    diagnostic(
      path,
      "missing_type",
      "node has keys #{inspect(Map.keys(node))} but no type",
      "a \"type\" field, usually supplied by view/<widget> or view/split"
    )
  end

  defp layout_failed(path, message) do
    diagnostic(path, "layout_failed", message, "a valid layout node")
  end

  defp diagnostic(path, reason, detail, expected),
    do: diagnostic(path, reason, detail, expected, %{})

  defp diagnostic(path, reason, detail, expected, extra) do
    Map.merge(
      %{
        "path" => path,
        "reason" => reason,
        "detail" => detail,
        "expected" => expected
      },
      extra
    )
  end

  defp type_name(value) when is_binary(value), do: "string"
  defp type_name(value) when is_boolean(value), do: "boolean"
  defp type_name(value) when is_integer(value), do: "integer"
  defp type_name(value) when is_float(value), do: "float"
  defp type_name(value) when is_atom(value), do: "atom"
  defp type_name(value) when is_list(value), do: "list"
  defp type_name(value) when is_map(value), do: "map"
  defp type_name(value) when is_tuple(value), do: "tuple"
  defp type_name(_value), do: "value"

  # ---- coercion helpers kept in sync with Surface ----

  defp kind(node) do
    case get(node, "type") do
      t when is_binary(t) -> t
      t when is_atom(t) and not is_nil(t) -> Atom.to_string(t)
      _ -> nil
    end
  end

  defp direction("horizontal"), do: :horizontal
  defp direction(:horizontal), do: :horizontal
  defp direction(_), do: :vertical

  defp constraints(_children, list) when is_list(list) and list != [],
    do: Enum.map(list, &constraint/1)

  defp constraints(children, _none) when is_list(children),
    do: List.duplicate({:fill, 1}, length(children))

  defp constraint([kind, a, b]), do: build_constraint(to_kind(kind), a, b)
  defp constraint([kind, a]), do: build_constraint(to_kind(kind), a, nil)
  defp constraint({kind, a}), do: build_constraint(to_kind(kind), a, nil)
  defp constraint({kind, a, b}), do: build_constraint(to_kind(kind), a, b)
  defp constraint(_), do: {:fill, 1}

  defp build_constraint(:length, n, _) when is_integer(n), do: {:length, n}
  defp build_constraint(:percentage, n, _) when is_integer(n), do: {:percentage, n}
  defp build_constraint(:min, n, _) when is_integer(n), do: {:min, n}
  defp build_constraint(:max, n, _) when is_integer(n), do: {:max, n}
  defp build_constraint(:fill, n, _) when is_integer(n), do: {:fill, n}
  defp build_constraint(:ratio, n, d) when is_integer(n) and is_integer(d), do: {:ratio, n, d}
  defp build_constraint(_, _, _), do: {:fill, 1}

  @constraint_kinds %{
    "length" => :length,
    "percentage" => :percentage,
    "min" => :min,
    "max" => :max,
    "fill" => :fill,
    "ratio" => :ratio
  }

  defp to_kind(k) when is_atom(k) and not is_nil(k), do: k
  defp to_kind(k) when is_binary(k), do: Map.get(@constraint_kinds, k)
  defp to_kind(_), do: nil

  defp split_opts(m) when is_map(m) do
    []
    |> put_flex(get(m, "flex"))
    |> put_nni(:spacing, get(m, "spacing"))
    |> put_nni(:margin, get(m, "margin"))
    |> put_nni(:horizontal_margin, get(m, "horizontal_margin"))
    |> put_nni(:vertical_margin, get(m, "vertical_margin"))
  end

  defp split_opts(_), do: []

  @flexes %{
    "legacy" => :legacy,
    "start" => :start,
    "end" => :end,
    "center" => :center,
    "space_between" => :space_between,
    "space_around" => :space_around
  }

  defp put_flex(opts, f) when is_binary(f) do
    case Map.get(@flexes, f) do
      nil -> opts
      flex -> Keyword.put(opts, :flex, flex)
    end
  end

  defp put_flex(opts, _), do: opts

  defp put_nni(opts, key, n) when is_integer(n) and n >= 0, do: Keyword.put(opts, key, n)
  defp put_nni(opts, _key, _), do: opts

  defp get(m, key) when is_map(m) do
    Map.get(m, key) || Map.get(m, safe_atom(key))
  end

  defp get(_m, _key), do: nil

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end

  defp safe_atom(_), do: nil
end
