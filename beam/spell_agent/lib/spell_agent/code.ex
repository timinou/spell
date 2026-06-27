defmodule SpellAgent.Code do
  @moduledoc """
  The `code/*` tools: source code as walkable `form_tree` data (PLAN-020 W3).

  The lispy CodePath surface. Where `sh/parse` turns bash into the canonical
  `form_tree` shape and `Hist.Lens.form_tree/1` turns recorded Lisp into it,
  `code/parse` turns SOURCE CODE into the SAME shape — so the one `q/*`
  structural algebra walks source, shell, and history alike.

  This module is the thin orchestrator seam between the agent and the kernel
  NIF (`PiKernelNif.parse_code_decoded/2` / `unparse_code_decoded/1`), which owns
  the tree-sitter parse + projection in Rust. This module owns only the tool
  contract: string-keyed args in, a `form_tree` map (or an `%{"error" => _}`
  map) out — never raises for a parse-level outcome, exactly like `SpellAgent.Sh`.

  ## Call shape

      (tool/code-parse {:src "def f, do: 1" :lang "elixir"})   ; → form_tree map
      (tool/code-unparse {:tree <form_tree>})                  ; → %{"src" => "…"}

  ## Result

  `code-parse` returns the `form_tree` map directly (string-keyed, JSON-safe):

      %{"node" => "source", "text" => "…", "children" => [ … ]}

  Each node carries `node` (the tree-sitter kind), optional `name` (the field
  role it fills in its parent), `value` (a leaf's source text), `text` (verbatim
  source slice, for byte-exact round-trip of untouched subtrees), and `children`.
  Exotic / error constructs degrade to a `%{"node" => "raw", "value" => src}`
  leaf rather than failing.
  """

  @doc """
  The native tool fn registered as `code-parse`. Parses `:src` under `:lang`
  into a `form_tree` map, or returns an `%{"error" => _}` map.
  """
  @spec parse_tool(map()) :: map()
  def parse_tool(args) when is_map(args) do
    with {:ok, src} <- require_string(args, "src"),
         {:ok, lang} <- require_string(args, "lang") do
      case safe_parse(src, lang) do
        {:ok, %{"error" => _} = err} -> err
        {:ok, tree} when is_map(tree) -> tree
        {:error, reason} -> %{"error" => to_string_reason(reason)}
        other -> %{"error" => "code-parse: unexpected result #{inspect(other)}"}
      end
    else
      {:error, message} -> %{"error" => message}
    end
  end

  # Wrap the NIF call so a load failure (`:nif_not_loaded` raises an ErlangError)
  # or any unexpected raise becomes a clean `{:error, _}` the tool turns into an
  # `%{"error" => _}` map — the tool NEVER crashes the agent on a bad/missing NIF.
  defp safe_parse(src, lang) do
    PiKernelNif.parse_code_decoded(src, lang)
  rescue
    e -> {:error, "code-parse: NIF unavailable (#{Exception.message(e)})"}
  end

  defp safe_unparse(tree) do
    PiKernelNif.unparse_code_decoded(tree)
  rescue
    e -> {:error, "code-unparse: NIF unavailable (#{Exception.message(e)})"}
  end

  @doc """
  The native tool fn registered as `code-unparse`. Renders a `form_tree` `:tree`
  back to source, returning `%{"src" => "…"}` or an `%{"error" => _}` map.

  ## Trust boundary (mirrors `sh/unparse`)

  `code-unparse` output of an AGENT-CONSTRUCTED tree is UNTRUSTED SOURCE. A
  `value`/`text` string renders VERBATIM, so a hand-built node like
  `%{"node" => "token", "value" => "; rm -rf /"}` produces that text unchanged.
  This is not itself an execution hole — `code-unparse` returns a STRING — but a
  caller that WRITES the result to disk (W5 `code/edit`) or executes it MUST
  treat it as untrusted: re-parse it (`code-parse`) and validate before commit.
  Source produced by `code-parse` of REAL source is, by construction, valid; a
  tree assembled by the agent is not.
  """
  @spec unparse_tool(map()) :: map()
  def unparse_tool(args) when is_map(args) do
    case Map.get(args, "tree") do
      tree when is_map(tree) ->
        case safe_unparse(tree) do
          {:ok, src} when is_binary(src) -> %{"src" => src}
          {:error, reason} -> %{"error" => to_string_reason(reason)}
          other -> %{"error" => "code-unparse: unexpected result #{inspect(other)}"}
        end

      _ ->
        %{"error" => "code-unparse: missing required :tree (a form_tree map)"}
    end
  end

  defp require_string(args, key) do
    case Map.get(args, key) do
      v when is_binary(v) -> {:ok, v}
      nil -> {:error, "code: missing required :#{key} (a string)"}
      other -> {:error, "code: :#{key} must be a string, got #{inspect(other)}"}
    end
  end

  defp to_string_reason(reason) when is_binary(reason), do: reason
  defp to_string_reason(reason), do: inspect(reason)
end
