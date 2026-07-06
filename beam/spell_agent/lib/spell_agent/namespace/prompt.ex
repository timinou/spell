defmodule SpellAgent.Namespace.Prompt do
  @moduledoc """
  Renders the agent's CAPABILITY DESCRIPTION for the system prompt from the ONE
  namespace catalog (FEAT-034), so the prompt can never drift from the callable
  surface.

  Before this, the capability list was hand-maintained in `system.md` prose and
  omitted most of the surface (hist/*, black/*, clock/*, the freeform verbs,
  spawn/await). It is now DERIVED from `SpellAgent.Tools.inventory/0` (which is
  itself derived from `SpellAgent.Namespace.Catalog`), grouped by namespace with
  each verb's call-form name, params, and one-line doc.

  This follows the same runtime-append pattern as `SpellAgent.Tui.Prelude.text/0`
  (a reflected section stitched onto the static base prompt), not a static string
  in `system.md` — because the inventory grows as the agent defines tools at
  runtime, and the description must always reflect what is ACTUALLY callable.
  """

  alias SpellAgent.Namespace.Catalog

  @heading "## Capabilities (the callable surface)"

  @preamble """
  Below is the surface you can call right now, grouped by namespace and derived
  live from the registry — so it always matches what is actually callable
  (tools you define at runtime appear here too). Call a `tool/`-prefixed verb as
  `(tool/name {…})`; call a bare-prefixed verb as `(prefix/verb {…})`.
  """

  @doc """
  The full capability section appended to the system prompt. Grouped by
  namespace, each verb rendered as `  <display-name>  {params}  — doc`.
  Degrades to a minimal note if the catalog cannot be read (never bricks the
  prompt).
  """
  @spec capability_text() :: String.t()
  def capability_text do
    groups = grouped_inventory()

    body =
      groups
      |> Enum.map(fn {ns, verbs} -> render_group(ns, verbs) end)
      |> Enum.join("\n\n")

    @heading <> "\n\n" <> @preamble <> "\n" <> body
  rescue
    _ -> @heading <> "\n\n" <> "(capability list unavailable)"
  end

  # Group the derived inventory by namespace, preserving catalog declaration
  # order. Runtime-defined tools (kind "ptc", namespace absent) collect under a
  # "your tools" group at the end.
  defp grouped_inventory do
    spec_order =
      Catalog.specs()
      |> Enum.map(& &1.prefix)
      |> Enum.uniq()

    inventory = SpellAgent.Tools.inventory()

    inventory
    |> Enum.group_by(fn entry -> Map.get(entry, "namespace", defined_group(entry)) end)
    |> Enum.sort_by(fn {ns, _} -> group_rank(ns, spec_order) end)
  end

  # Runtime-defined tools carry kind "ptc" and no "namespace" key.
  defp defined_group(%{"kind" => "ptc"}), do: "your tools"
  defp defined_group(_), do: "misc"

  defp group_rank(ns, spec_order) do
    case Enum.find_index(spec_order, &(&1 == ns)) do
      nil -> length(spec_order) + rank_tail(ns)
      i -> i
    end
  end

  defp rank_tail("your tools"), do: 1
  defp rank_tail(_), do: 2

  defp render_group(ns, verbs) do
    rows =
      verbs
      |> Enum.map(&render_verb/1)
      |> Enum.join("\n")

    header = group_header(ns, List.first(verbs))
    header <> "\n" <> rows
  end

  defp group_header("your tools", _), do: "your tools (defined at runtime):"

  defp group_header(ns, first) do
    effect = first && Map.get(first, "effect")
    if effect, do: "#{ns}/ (#{effect}):", else: "#{ns}/:"
  end

  defp render_verb(%{"name" => name} = entry) do
    params =
      case Map.get(entry, "params", []) do
        [] -> ""
        list -> " {" <> Enum.join(list, " ") <> "}"
      end

    doc = entry |> Map.get("doc", "") |> first_sentence()
    "  " <> name <> params <> maybe_dash(doc)
  end

  defp maybe_dash(""), do: ""
  defp maybe_dash(doc), do: "  — " <> doc

  # Keep the prompt tight: one sentence per verb (the inventory docs carry richer
  # examples for `list-tools`, but the prompt only needs the gist).
  defp first_sentence(doc) do
    doc
    |> String.split(~r/\.\s/, parts: 2)
    |> List.first()
    |> String.trim()
    |> String.replace_trailing(".", "")
  end
end
