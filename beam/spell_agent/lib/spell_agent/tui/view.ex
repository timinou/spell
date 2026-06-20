defmodule SpellAgent.Tui.View do
  @moduledoc """
  The `view/` + `theme/` PTC-Lisp surfaces (PLAN-009) — the render mirror's
  agent-facing builders, the sibling of `harness/` (gaze transforms) and
  `keymap/` (rebinding).

  `view/<widget>` builds a layout-tree NODE as plain data. A builder is
  deliberately THIN: `(view/paragraph {:text "hi"})` just tags the args map with
  `"type" => "paragraph"`. All the real work — coercion to a real `%Widget{}` and
  validation — happens later in `Materialize` + `Surface` + the existing
  `ExRatatui.Bridge`. So a builder is a pure data-tagger, and the set of builders
  is REFLECTED from `SpellAgent.Tui.Reflect` (one per ex_ratatui widget) — adding
  a widget upstream adds a `view/` builder automatically, no per-widget code.

  Two non-widget builders complete the surface:

    * `view/split` — the layout spine: `{:dir :constraints :children :opts}` ->
      a split node `Surface` divides a rect with.
    * `theme/set` — recolor a palette slot (`ThemeRegistry`); cross-cutting color
      in one op (Edge T).

  ## Theme defaults (Edge T)

  A widget builder with NO explicit `:style` gets a style derived from the live
  theme for its ROLE — borders use `border`/`border_focused`, body text uses
  `text`. This is why "make errors magenta" is one `theme/set`, not an edit to
  every builder call: the builders read the palette.

  These verbs return DATA (a node map), with no side effects — except `theme/set`,
  which mutates the `ThemeRegistry`. So `view/*` is pure and safe to run on the
  frame clock; `theme/set` is a deliberate meta-op like `keymap/bind`.
  """

  alias SpellAgent.Tui.{Reflect, ThemeRegistry}

  @doc """
  The `view/` + `theme/` tool entries (qualified name => `(args -> node)`), to
  merge into the tools map a slot program (or the agent) runs with.

  Reflected: one `view/<name>` per reflected widget, plus `view/split` and
  `theme/set`.
  """
  @spec tools() :: %{optional(String.t()) => (map() -> term())}
  def tools do
    widget_builders()
    |> Map.put("view/split", &build_split/1)
    |> Map.put("theme/set", &theme_set/1)
    |> Map.put("theme/show", fn _args -> ThemeRegistry.as_map() end)
  end

  # ---- reflected widget builders ----

  # One builder per reflected widget name. The builder stamps "type" => name onto
  # the (stringified) args and applies any theme default for the widget's role.
  defp widget_builders do
    for name <- Reflect.names(), into: %{} do
      {"view/" <> name, fn args -> build_widget(name, args) end}
    end
  end

  defp build_widget(name, args) do
    args
    |> stringify_keys()
    |> Map.put("type", name)
    |> apply_theme_defaults(name)
  end

  # ---- view/split ----

  defp build_split(args) do
    a = stringify_keys(args)

    %{
      "type" => "split",
      "dir" => Map.get(a, "dir", "vertical"),
      "constraints" => Map.get(a, "constraints", []),
      "children" => Map.get(a, "children", []),
      "opts" => Map.get(a, "opts", %{})
    }
  end

  # ---- theme/set ----

  defp theme_set(args) do
    a = stringify_keys(args)
    slot = Map.get(a, "slot")
    # Accept either a single color under :fg/:color, or a full {:fg :bg ...}.
    color = Map.get(a, "fg") || Map.get(a, "color")

    case ThemeRegistry.put(slot, color) do
      :ok -> ThemeRegistry.as_map()
      {:error, reason} -> %{"err" => reason}
    end
  end

  # ---- theme defaults (Edge T) ----
  #
  # A builder with no explicit style gets a sensible default FROM the live theme
  # for the widget's role. Kept minimal in v1: block borders + body text. A
  # builder that DID pass :style/:block keeps its own — explicit always wins.

  defp apply_theme_defaults(node, "block") do
    Map.put_new_lazy(node, "border_style", fn -> %{"fg" => border_color()} end)
  end

  defp apply_theme_defaults(node, name) when name in ["paragraph", "list", "table"] do
    node
    |> Map.put_new_lazy("style", fn -> %{"fg" => text_color()} end)
  end

  defp apply_theme_defaults(node, _name), do: node

  defp border_color, do: theme_color("border")
  defp text_color, do: theme_color("text")

  defp theme_color(slot) do
    case Map.get(ThemeRegistry.as_map(), slot) do
      nil -> nil
      c -> c
    end
  end

  # ---- helpers ----

  defp stringify_keys(m) when is_map(m) do
    Map.new(m, fn {k, v} -> {to_string(k), v} end)
  end

  defp stringify_keys(_), do: %{}
end
