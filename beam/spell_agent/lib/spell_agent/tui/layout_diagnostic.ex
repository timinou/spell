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
  alias SpellAgent.Tui.{Materialize, SplitSpec, Surface, Tree}

  @type diagnostic :: %{
          required(String.t()) => term()
        }

  @probe_rect %Rect{x: 0, y: 0, width: 80, height: 24}

  @doc "Validate that a layout source produces encodable leaves."
  @spec validate(term()) :: :ok | {:error, diagnostic()}
  def validate(node) do
    with {:ok, resolved} <- resolve_holes(node),
         :ok <- detect_unevaluated_forms(resolved),
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

  # ---- unevaluated-form detection (post-resolve) ----

  # A `tmpl::` quasiquote freezes every non-~ form as inert CoreAST data. A bare
  # call like `(str … ~x …)` (no `~` on the `str`) survives `resolve_holes` as a
  # list whose head is `{:symbol_ref, "str"}`; a bare ref `:fg data/x` (no `~`)
  # survives as the `{:symbol_ref, _}` tuple itself. Both then fail the encoder
  # with an opaque "cannot coerce […] into %Text{}" — so catch them HERE, after
  # holes resolve and before the encode walk, and name the cause + the one-char
  # fix (wrap the whole expression in `~`). (PLAN-017 / BUG-013.)
  defp detect_unevaluated_forms(node), do: scan(node, "source")

  defp scan(map, path) when is_map(map) and not is_struct(map) do
    Enum.reduce_while(map, :ok, fn {k, v}, :ok ->
      if frozen_call?(v) do
        {:halt, {:error, unevaluated_diag("#{path}.#{k}", k, frozen_name(v))}}
      else
        case scan(v, "#{path}.#{k}") do
          :ok -> {:cont, :ok}
          {:error, _} = err -> {:halt, err}
        end
      end
    end)
  end

  defp scan(list, path) when is_list(list) do
    list
    |> Enum.with_index()
    |> Enum.reduce_while(:ok, fn {el, i}, :ok ->
      if frozen_call?(el) do
        {:halt, {:error, unevaluated_diag("#{path}[#{i}]", nil, frozen_name(el))}}
      else
        case scan(el, "#{path}[#{i}]") do
          :ok -> {:cont, :ok}
          {:error, _} = err -> {:halt, err}
        end
      end
    end)
  end

  defp scan(_other, _path), do: :ok

  # A frozen call is a list headed by `{:symbol_ref, _}` (the codec's CoreAST
  # shape for a symbol); a frozen bare ref is the tuple itself.
  defp frozen_call?([{:symbol_ref, _} | _]), do: true
  defp frozen_call?({:symbol_ref, _}), do: true
  defp frozen_call?(_), do: false

  defp frozen_name([{:symbol_ref, name} | _]), do: name
  defp frozen_name({:symbol_ref, name}), do: name

  defp unevaluated_diag(path, field, name) do
    case field do
      nil ->
        diagnostic(
          path,
          "unevaluated_form",
          "a `(#{name} …)` inside tmpl:: froze as inert data — only ~-marked forms " <>
            "evaluate, so the call never ran. Wrap the whole expression in ~:  ~(#{name} …)",
          "a literal value, or a single ~-wrapped expression"
        )

      k ->
        label = field_label(k)

        diagnostic(
          path,
          "unevaluated_form",
          "a `(#{name} …)` inside tmpl:: froze as inert data — only ~-marked forms " <>
            "evaluate, so the call never ran. Wrap the whole expression in ~:  #{label} ~(#{name} …)",
          "a literal value, or a single ~-wrapped expression for field #{label}"
        )
    end
  end

  defp field_label(k) when is_binary(k), do: ":#{k}"
  defp field_label(k), do: inspect(k)

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
            SplitSpec.direction(get(node, "dir")),
            SplitSpec.constraints(children, get(node, "constraints")),
            SplitSpec.split_opts(get(node, "opts"))
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

  # ---- node accessors (PLAN-021 W1: split coercion -> SplitSpec, key access -> Tree) ----

  defp kind(node), do: Tree.kind(node)

  defp get(m, key), do: Tree.get(m, key)
end
