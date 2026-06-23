defmodule SpellAgent.Tui.Transcript do
  @moduledoc """
  Renders a session's conversation as its NATIVE Lisp — the homoiconic transcript
  (PLAN-001). The Hist substrate IS code-as-data: each `Node.form_src` is the full
  PTC-Lisp program the model emitted (comments, `(tool/…)` calls, `(def …)` binds
  intact), and `Node.sees` carries each tool call's REALIZED result. So the most
  faithful "dump the conversation" shape is to print those programs in order, not
  to reformat the lossy Anthropic wire messages or a one-line summary.

  This is the complement to `SessionView.trace_text/2` (the lossy structural
  index) and supersedes a wire-message render: it keeps the agent's actual code
  (the `;;` reasoning comments, the program structure) which a tool_use-block view
  discards. The at-exit trace dump (`SpellAgent.tui/1`) prefers this transcript
  and falls back to the structural trace when a session recorded no nodes.

  ## Per turn

      ;;; turn N · status · in/out tok
      ;; user                 (only on the turn that opened the step)
      <prompt in full>

      <form_src in full — the PTC-Lisp program>

      ;; ⇒ <tool name>         (each realized tool call)
      ;;   <result>  <status>

      ;; => <turn result>       (the program's final value)

  Individual results are capped (default 8_000 chars) so one pathological blob
  cannot drown the transcript; the cap is marked. Pure (store -> string).
  """

  alias SpellAgent.Hist

  @default_cap 8_000

  @doc """
  Render `session_id`'s conversation as a Lisp transcript, or `nil` if the session
  recorded no nodes (callers fall back to `SessionView.trace_text/2`).

  Options:
    * `:cap` — max chars per individual result/value before truncation
      (default `#{ @default_cap }`).
  """
  @spec text(module(), String.t(), keyword()) :: String.t() | nil
  def text(store, session_id, opts \\ []) do
    case Hist.resume(session_id, store: store) do
      {:ok, %{nodes: []}} -> nil
      {:ok, %{nodes: nodes}} -> render(session_id, nodes, opts)
      _ -> nil
    end
  end

  defp render(session_id, nodes, opts) do
    cap = Keyword.get(opts, :cap, @default_cap)
    {ins, outs} = node_tokens(nodes)
    tok = if ins > 0 or outs > 0, do: "  #{fmt_tok(ins)} in / #{fmt_tok(outs)} out", else: ""
    header = ";;; #{session_id}  (#{length(nodes)} turns#{tok})"

    body =
      nodes
      |> Enum.with_index(1)
      |> Enum.map(fn {n, idx} -> render_node(n, idx, cap) end)
      |> Enum.join("\n\n\n")

    header <> "\n\n" <> body
  end

  defp render_node(%{seq: seq, status: status, prompt: prompt, form_src: form_src, sees: sees, result: result, tokens: tokens}, idx, cap) do
    head = ";;; turn #{idx} (##{seq}) · #{status}#{tok_part(tokens)}"

    parts =
      [head] ++
        user_part(prompt, cap) ++
        form_part(form_src, cap) ++
        [effects_part(sees, cap)] ++
        result_part(result, cap)

    parts |> Enum.reject(&(&1 == "")) |> Enum.join("\n\n")
  end

  defp user_part(nil, _cap), do: []
  defp user_part(prompt, cap), do: [";; user\n" <> capv(prompt, cap)]

  defp form_part(nil, _cap), do: []
  defp form_part("", _cap), do: []
  defp form_part(form_src, cap), do: [capv(String.trim(form_src), cap)]

  # `sees` = realized tool calls: [%{name, args, result}], atom- OR string-keyed.
  defp effects_part([], _cap), do: ""
  defp effects_part(nil, _cap), do: ""

  defp effects_part(sees, cap) when is_list(sees) do
    lines =
      Enum.map(sees, fn see ->
        name = g(see, :name) || g(see, "name") || "?"
        res = g(see, :result)
        st = result_status(res)

        ";; \u21d2 #{name}\n;;   #{capv(pretty(res), cap)}  #{st}"
      end)

    Enum.join(lines, "\n")
  end

  defp result_part(nil, _cap), do: []
  defp result_part(result, cap), do: [";; => #{capv(pretty(result), cap)}"]

  defp tok_part(%{input: i, output: o}) when is_integer(i) and is_integer(o),
    do: "  \u00b7 #{fmt_tok(i)}/#{fmt_tok(o)}"

  defp tok_part(%{"input" => i, "output" => o}) when is_integer(i) and is_integer(o),
    do: "  \u00b7 #{fmt_tok(i)}/#{fmt_tok(o)}"

  defp tok_part(_), do: ""

  defp node_tokens(nodes) do
    Enum.reduce(nodes, {0, 0}, fn n, {i, o} ->
      case n.tokens do
        %{input: ti, output: to} when is_integer(ti) and is_integer(to) -> {i + ti, o + to}
        %{"input" => ti, "output" => to} when is_integer(ti) and is_integer(to) -> {i + ti, o + to}
        _ -> {i, o}
      end
    end)
  end

  defp result_status(result) do
    # Mirror Hist.Result.status/1's intent without the dependency: nil/false -> a
    # soft note, anything else -> ok. The status is display-only here.
    case result do
      nil -> "nil"
      false -> "false"
      {:error, _} -> "error"
      %{"error" => _} -> "error"
      _ -> "ok"
    end
  end

  defp pretty(term), do: inspect(term, pretty: true, limit: :infinity)

  defp capv(s, n) when is_binary(s) and byte_size(s) > n do
    String.slice(s, 0, n) <> " \u2026 (#{byte_size(s)} bytes, capped at #{n})"
  end

  defp capv(s, _n) when is_binary(s), do: s
  defp capv(other, n), do: capv(pretty(other), n)

  defp fmt_tok(n) when is_integer(n), do: :erlang.float_to_binary(n / 1000, decimals: 1) <> "k"

  # Atom- OR string-keyed read (sees mixes both shapes across recorder versions).
  defp g(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} -> value
      :error -> Map.get(map, to_string(key))
    end
  end

  defp g(_map, _key), do: nil
end
