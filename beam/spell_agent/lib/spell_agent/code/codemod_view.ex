defmodule SpellAgent.Code.CodemodView do
  @moduledoc """
  Pure text formatters for the codemod inspector (`mix spell.codemod`, PLAN-022 S2).

  Mirrors `SpellAgent.Mesh.MeshView`: pure functions from a codemod RESULT to
  lines, so the stdout task and any future TUI pane share ONE rendering and can
  never drift. No process, no file I/O here — the caller (the mix task) reads the
  source, runs the transform through the real `code/*` + `q/*` surface, and passes
  the structured result in.

  The showcase makes the lispy code/edit surface VISIBLE: a codemod is `code/parse
  -> q/apply-ops (the reified data ops) -> code/unparse`, and this renders all four
  facets a reader wants — the BEFORE source, the OPS AS DATA (the reifiable
  transform, the PLAN-018 currency), the AFTER source, and the parse-gate VERDICT
  (does the rewritten tree re-parse clean — the W5 safety invariant).
  """

  @typedoc """
  A rendered codemod outcome. `:ops` is the reified op-list (data the reducer can
  compose); `:before`/`:after` are source strings; `:verdict` is `:ok` when the
  rewrite re-parses clean, or `{:error, reason}` when the transform/gate failed
  (in which case `:after` is nil).
  """
  @type result :: %{
          lang: String.t(),
          ops: [map()],
          before: String.t(),
          after: String.t() | nil,
          verdict: :ok | {:error, String.t()}
        }

  @doc """
  Render a codemod result as a labelled before/ops/after/verdict report.

  `path` is shown in the header for context (the file the codemod targets). The
  output is deterministic (no ids, no timestamps) so it is snapshot-stable.
  """
  @spec report_text(String.t(), result()) :: String.t()
  def report_text(path, %{} = result) do
    [
      header(path, result.lang),
      section("BEFORE", result.before),
      section("OPS (reified data)", ops_text(result.ops)),
      after_section(result),
      verdict_text(result.verdict)
    ]
    |> Enum.join("\n")
    |> Kernel.<>("\n")
  end

  @doc "Render just the op-list as pretty data lines (one op per stanza)."
  @spec ops_text([map()]) :: String.t()
  def ops_text([]), do: "  (no ops)"

  def ops_text(ops) do
    ops
    |> Enum.with_index(1)
    |> Enum.map_join("\n", fn {op, i} -> op_stanza(i, op) end)
  end

  # ---- sections ----

  defp header(path, lang), do: "CODEMOD  #{path}  (#{lang})"

  defp section(label, body) do
    "#{label}\n#{indent(body)}"
  end

  # The AFTER source, or a note that the transform produced no source (rejected).
  defp after_section(%{after: nil}), do: "AFTER\n  (rejected — see verdict)"
  defp after_section(%{after: src}), do: section("AFTER", src)

  defp verdict_text(:ok), do: "VERDICT  ok (re-parses clean)"
  defp verdict_text({:error, reason}), do: "VERDICT  rejected: #{reason}"

  # One op rendered as readable data: its kind + the pattern/template form_trees.
  # Strings keys are normalized so a PTC-built op and a hand-built one render alike.
  defp op_stanza(i, op) do
    kind = fetch(op, "op") || "?"
    pattern = fetch(op, "pattern")
    template = fetch(op, "template")

    [
      "  #{i}. #{kind}",
      kv("pattern", pattern),
      kv("template", template)
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
  end

  defp kv(_label, nil), do: nil
  defp kv(label, form), do: "       #{label}: #{compact_form(form)}"

  # A compact single-line rendering of a form_tree node: node[name=…][value=…]
  # with a child count, so a reader sees the shape without a multi-line dump.
  defp compact_form(%{} = form) do
    node = fetch(form, "node") || "?"
    name = fetch(form, "name")
    value = fetch(form, "value")
    children = fetch(form, "children") || []

    parts =
      [
        if(name, do: "name=#{inspect(name)}"),
        if(not is_nil(value), do: "value=#{inspect(value)}"),
        if(children != [], do: "children=#{length(children)}")
      ]
      |> Enum.reject(&is_nil/1)

    case parts do
      [] -> node
      _ -> "#{node}[#{Enum.join(parts, " ")}]"
    end
  end

  defp compact_form(other), do: inspect(other)

  # Indent a (possibly multi-line) block by two spaces per line.
  defp indent(text) do
    text
    |> String.split("\n")
    |> Enum.map_join("\n", fn line -> "  " <> line end)
  end

  # form_tree maps use string keys; ops a PTC program builds may carry either —
  # read string-first, atom-fallback, exactly like the code/mesh boundary helpers.
  defp fetch(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, v} -> v
      :error -> Map.get(map, safe_atom(key))
    end
  end

  defp fetch(_map, _key), do: nil

  defp safe_atom(k) when is_binary(k) do
    String.to_existing_atom(k)
  rescue
    ArgumentError -> nil
  end
end
