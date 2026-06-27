defmodule SpellAgent.Mesh.MeshView do
  @moduledoc """
  Pure text formatters for the mesh inspector (FEAT-014/015, PLAN-019 M4).

  Mirrors `SpellAgent.Tui.SessionView`: pure functions from mesh data to lines, so
  the stdout modes (`mix spell.mesh --list` / `--region` / `--fold`) and any future
  TUI pane share ONE rendering and can never drift. No process, no store access \u2014
  the caller fetches via `Mesh.Store` and passes the data in.
  """

  alias SpellAgent.Mesh.Record

  @doc "Render the region index (every region + its record/kind counts)."
  @spec regions_text([map()]) :: String.t()
  def regions_text([]), do: "(no mesh regions)\n"

  def regions_text(regions) do
    header = "REGIONS (#{length(regions)})\n"

    body =
      Enum.map_join(regions, "\n", fn %{region: region, count: count, kinds: kinds} ->
        kind_summary =
          kinds
          |> Enum.sort_by(fn {k, _} -> to_string(k) end)
          |> Enum.map_join("  ", fn {k, n} -> "#{k}:#{n}" end)

        "  #{region}  (#{count})  #{kind_summary}"
      end)

    header <> body <> "\n"
  end

  @doc "Render one region's board: its records, ascending seq, grouped by kind."
  @spec board_text(String.t(), [Record.t()]) :: String.t()
  def board_text(region, []), do: "REGION #{region}\n  (empty)\n"

  def board_text(region, records) do
    header = "REGION #{region}  (#{length(records)} records)\n"

    body =
      records
      |> Enum.sort_by(& &1.seq)
      |> Enum.map_join("\n", &record_line/1)

    header <> body <> "\n"
  end

  @doc "Render a fold result (a scalar, a list, or a map) as text."
  @spec fold_text(term()) :: String.t()
  def fold_text(result) when is_integer(result), do: "#{result}\n"
  def fold_text(result) when is_binary(result), do: result <> "\n"

  def fold_text(result) when is_list(result) do
    Enum.map_join(result, "\n", &inspect/1) <> "\n"
  end

  def fold_text(result) when is_map(result) do
    result
    |> Enum.sort_by(fn {k, _} -> to_string(k) end)
    |> Enum.map_join("\n", fn {k, v} -> "  #{k}: #{inspect(v)}" end)
    |> Kernel.<>("\n")
  end

  def fold_text(result), do: inspect(result) <> "\n"

  # One record line: seq, kind, author, a compact payload.
  defp record_line(%Record{seq: seq, kind: kind, author: author, payload: payload}) do
    "  [#{pad(seq)}] #{kind}#{author_tag(author)}  #{compact(payload)}"
  end

  defp author_tag(nil), do: ""
  defp author_tag(author), do: " @#{author}"

  defp pad(seq) when is_integer(seq), do: String.pad_leading(Integer.to_string(seq), 4)
  defp pad(_), do: "   ?"

  # A compact one-line payload rendering (keys sorted, truncated).
  defp compact(payload) when is_map(payload) and map_size(payload) == 0, do: "{}"

  defp compact(payload) when is_map(payload) do
    inner =
      payload
      |> Enum.sort_by(fn {k, _} -> to_string(k) end)
      |> Enum.map_join(" ", fn {k, v} -> "#{k}=#{truncate(inspect(v))}" end)

    "{#{inner}}"
  end

  defp compact(other), do: inspect(other)

  defp truncate(s) when byte_size(s) > 48, do: binary_part(s, 0, 45) <> "..."
  defp truncate(s), do: s
end
