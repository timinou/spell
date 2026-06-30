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

  Each node carries `node` (the tree-sitter kind), optional `field` (the role it
  fills in its parent, e.g. `left`/`right`/`argument` — NOT `name`, which is
  reserved for a semantic name across all form_tree producers), `value` (a leaf's
  source text), `text` (verbatim source slice, for byte-exact round-trip of
  untouched subtrees), and `children`. Exotic / error constructs degrade to a
  `%{"node" => "raw", "value" => src}` leaf rather than failing.

  ## Editing

  `code-edit {:path :tree :lang}` is the parse-GATED, transactional write seam.
  The agent produces the edited `:tree` in its OWN program (via the `q/*`
  algebra: `(q/update (tool/code-parse {...}) pattern f)` or `(q/apply-ops ...)`),
  keeping the edit a reifiable DATA value PLAN-018 can compose. `code-edit` then:

    1. unparses `:tree` to source;
    2. PARSE-GATES it — re-parses the source and requires a CLEAN tree (no error
       region, no `raw` leaf); a tree that does not yield valid source is REJECTED
       and the file is left untouched. An empty/whitespace-only result is also
       rejected (an edit must not silently truncate a file);
    3. writes the file ATOMICALLY (write a temp sibling, then rename over the
       target) so a mid-write failure can never leave a truncated/partial file.

  ## One-call sugar: `code-apply`

  `code-edit` makes the agent thread the whole parse->q/*->write pipeline by
  hand (read the file, `code-parse` it, apply the edit, pass the tree back). The
  `code-apply {:path :ops}` tool collapses that to ONE call (FEAT-025):

      (tool/code-apply {:path "f.ex" :ops [(q/rename-id "x" "y")]})

  It infers `:lang` from the path extension (the engine registry is the single
  source of truth, via `PiKernelNif.language_for_path/1`), reads + parses the
  file, applies the `:ops` data-list with `q/apply-ops`, then routes through the
  EXACT SAME gate pipeline as `code-edit` (unparse -> nonempty -> parse-gate ->
  atomic write). `:ops` is plain data built by the pure `q/*` sugar
  (`q/rename-id`, `q/rewrite-op`, `q/wrap-op`) — so the recorded edit stays a
  reifiable value (PLAN-018), exactly as with `code-edit`.

  Why a NATIVE tool and not a `q/*` prelude fn: the pipeline is effectful
  (reads + writes a file, calls other tools). A prelude fn that wrapped
  `tool/code-parse`/`tool/code-edit` would (a) bypass the runner's preflight
  side-effect guard (a tool hidden inside a prelude export is invisible to
  `check_undefined_tools`) and (b) not even compile — a prelude namespace cannot
  qualified-call a SIBLING prelude namespace's exports. Orchestration belongs in
  Elixir ("Elixir materializes, PTC transforms"); the pure data sugar stays in
  the `q/*` prelude.

  ## Atomicity scope

  The write is ATOMIC at the filesystem level (temp + rename): the target is
  either its old content or the full new content, never a partial.

  It also participates in ALL-OR-NOTHING rollback within a failing program
  (FUP-027): before overwriting, `gate_write` snapshots the target's prior state
  into `SpellAgent.Code.Journal` (a worker-side stack), and the runner's
  `on_complete` finalizer drains it by the program's verdict — a `(fail …)` after
  one or more `code-edit`s restores every touched file (a created file is
  deleted), while a successful program keeps the writes. The finalizer is wired
  onto the agent in `Session.run`; a `code-edit` run WITHOUT it (a bare
  `Lisp.run`) keeps the plain FS-atomic write with no rollback (additive,
  opt-in). LIMITATION (v1): rollback covers edits in the main program flow; an
  edit inside a `pmap`/`pcalls` sub-worker records in that separate process,
  outside the top-level finalizer — a narrow follow-up.
  """

  alias SpellAgent.Code.Journal

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

  @doc """
  The native tool fn registered as `code-edit`. Parse-gated, transactional write.

  Args: `:path` (file to write), `:tree` (the edited form_tree the agent built
  via q/*), `:lang` (for the parse-gate). Returns `%{"path" => p, "bytes" => n,
  "src" => s}` on success, or `%{"error" => _}` — and on ANY gate failure the
  file is left UNTOUCHED.

  The gate is the safety core: the edited tree is unparsed to source, then
  RE-PARSED; if re-parsing fails (the edit produced unparseable source) the write
  is refused. This is the structural-invariance contract — an edit may change
  meaning, but it must still be valid source.
  """
  @spec edit_tool(map()) :: map()
  def edit_tool(args) when is_map(args) do
    with {:ok, path} <- require_string(args, "path"),
         {:ok, lang} <- require_string(args, "lang"),
         {:ok, tree} <- require_tree(args),
         {:ok, src} <- gate_unparse(tree),
         :ok <- gate_nonempty(src),
         :ok <- gate_reparse(src, lang),
         :ok <- gate_write(path, src) do
      %{"path" => path, "bytes" => byte_size(src), "src" => src}
    else
      {:error, message} -> %{"error" => message}
    end
  end

  @doc """
  The native tool fn registered as `code-apply` (FEAT-025). The one-call edit
  sugar: resolve `:lang` from `:path`, read + parse the file, apply the `:ops`
  data-list via `q/apply-ops`, then route the edited tree through the SAME gate
  pipeline as `code-edit`. Returns `%{"path", "bytes", "src"}` on success or an
  `%{"error" => _}` map; never raises for an edit-level outcome.

  `:ops` is a list of op maps (`%{"op" => "update"|"rewrite"|"wrap", "pattern" =>
  _, "template" => _}`) — plain data, typically built by the pure `q/*` sugar.
  An empty `:ops` list is refused (a no-op edit is a caller mistake, not a write).
  """
  @spec apply_tool(map()) :: map()
  def apply_tool(args) when is_map(args) do
    with {:ok, path} <- require_string(args, "path"),
         {:ok, ops} <- require_ops(args),
         {:ok, lang} <- resolve_lang(args, path),
         {:ok, src0} <- read_source(path),
         {:ok, tree} <- parse_source(src0, lang),
         {:ok, edited} <- apply_ops(tree, ops),
         {:ok, out_src} <- gate_unparse(edited),
         :ok <- gate_nonempty(out_src),
         :ok <- gate_reparse(out_src, lang),
         :ok <- gate_write(path, out_src) do
      %{"path" => path, "bytes" => byte_size(out_src), "src" => out_src}
    else
      {:error, message} -> %{"error" => message}
    end
  end

  # `:ops` must be a non-empty list of op maps. Empty is refused: applying no ops
  # would re-write the file with a re-rendered (presentation-canonicalized) copy
  # for no edit — a caller mistake, not an intended write.
  defp require_ops(args) do
    case Map.get(args, "ops") do
      [_ | _] = ops -> {:ok, ops}
      [] -> {:error, "code-apply: :ops is empty (no edit to apply)"}
      nil -> {:error, "code-apply: missing required :ops (a non-empty list of op maps)"}
      other -> {:error, "code-apply: :ops must be a list of op maps, got #{inspect(other)}"}
    end
  end

  # Lang is inferred from the path extension via the engine registry (single
  # source of truth), but an explicit `:lang` arg WINS (a caller editing a file
  # with a non-standard extension can still name the grammar).
  defp resolve_lang(args, path) do
    case Map.get(args, "lang") do
      lang when is_binary(lang) and lang != "" ->
        {:ok, lang}

      _ ->
        case safe_language_for_path(path) do
          {:ok, lang} -> {:ok, lang}
          {:error, reason} -> {:error, "code-apply: #{to_string_reason(reason)}"}
        end
    end
  end

  defp safe_language_for_path(path) do
    PiKernelNif.language_for_path(path)
  rescue
    e -> {:error, "language detection NIF unavailable (#{Exception.message(e)})"}
  end

  defp read_source(path) do
    case File.read(path) do
      {:ok, src} ->
        {:ok, src}

      {:error, reason} ->
        {:error, "code-apply: cannot read #{path} (#{:file.format_error(reason)})"}
    end
  end

  defp parse_source(src, lang) do
    case safe_parse(src, lang) do
      {:ok, %{"error" => reason}} ->
        {:error, "code-apply: parse failed (#{to_string_reason(reason)})"}

      {:ok, tree} when is_map(tree) ->
        {:ok, tree}

      {:error, reason} ->
        {:error, "code-apply: parse failed (#{to_string_reason(reason)})"}

      other ->
        {:error, "code-apply: parse unexpected (#{inspect(other)})"}
    end
  end

  # Apply the data-ops by running `(q/apply-ops data/tree data/ops)` in-process
  # with the compiled q/* prelude — the SAME engine the agent's own programs use,
  # so an op-list behaves identically whether the agent applies it inline or via
  # this tool. A prelude that failed to compile (nil) is a hard error here: there
  # is no meaningful fallback for an op-application tool without the algebra.
  defp apply_ops(tree, ops) do
    case SpellAgent.Code.Prelude.compiled() do
      nil ->
        {:error, "code-apply: q/* prelude unavailable (cannot apply ops)"}

      prelude ->
        run_apply(prelude, tree, ops)
    end
  end

  defp run_apply(prelude, tree, ops) do
    case PtcRunner.Lisp.run("(q/apply-ops data/tree data/ops)",
           prelude: prelude,
           context: %{"tree" => tree, "ops" => ops},
           filter_context: false,
           caller: :in_process_v1
         ) do
      {:ok, step} ->
        classify_apply_return(step.return)

      {:error, step} ->
        {:error, "code-apply: ops application failed (#{inspect(step.fail || step.return)})"}
    end
  end

  # `q/apply-op` calls `fail` on an unknown op kind, which surfaces as a
  # `{:__ptc_fail__, msg}` value in step.return (NOT an {:error, step}); turn it
  # into a clean error map so a typo'd op kind never silently writes the file.
  defp classify_apply_return({:__ptc_fail__, msg}),
    do: {:error, "code-apply: #{to_string_reason(msg)}"}

  defp classify_apply_return(tree) when is_map(tree), do: {:ok, tree}

  defp classify_apply_return(other),
    do: {:error, "code-apply: ops did not yield a tree (#{inspect(other)})"}

  # An edit that unparses to empty/whitespace-only source would TRUNCATE the file
  # (empty source parses clean, so the parse-gate alone would not catch it). Refuse
  # it — emptying a file is never an intended structural edit; a caller that truly
  # wants to clear a file should not route through code-edit.
  defp gate_nonempty(src) do
    if String.trim(src) == "",
      do: {:error, "code-edit: refused (edit unparses to empty source; would truncate the file)"},
      else: :ok
  end

  defp require_tree(args) do
    case Map.get(args, "tree") do
      tree when is_map(tree) -> {:ok, tree}
      _ -> {:error, "code-edit: missing required :tree (a form_tree map)"}
    end
  end

  defp gate_unparse(tree) do
    case safe_unparse(tree) do
      {:ok, src} when is_binary(src) -> {:ok, src}
      {:error, reason} -> {:error, "code-edit: unparse failed (#{to_string_reason(reason)})"}
      other -> {:error, "code-edit: unparse unexpected (#{inspect(other)})"}
    end
  end

  # The PARSE-GATE: the edited source MUST re-parse without producing a top-level
  # error/raw region, or the edit yielded invalid source and is refused.
  defp gate_reparse(src, lang) do
    case safe_parse(src, lang) do
      {:ok, %{"error" => reason}} ->
        {:error, "code-edit: parse-gate rejected the edit (#{to_string_reason(reason)})"}

      {:ok, tree} when is_map(tree) ->
        if reparse_clean?(tree),
          do: :ok,
          else: {:error, "code-edit: parse-gate rejected the edit (unparseable result)"}

      {:error, reason} ->
        {:error, "code-edit: parse-gate failed (#{to_string_reason(reason)})"}

      other ->
        {:error, "code-edit: parse-gate unexpected (#{inspect(other)})"}
    end
  end

  # A re-parsed tree is "clean" if it contains no ERROR node and no raw leaf that
  # spans real content — i.e. the edit produced structurally valid source. A raw
  # leaf or error:true anywhere means the edit broke the grammar.
  defp reparse_clean?(node) when is_map(node) do
    cond do
      Map.get(node, "error") == true -> false
      Map.get(node, "node") == "raw" -> false
      true -> Enum.all?(Map.get(node, "children", []), &reparse_clean?/1)
    end
  end

  defp reparse_clean?(_), do: true

  # ATOMIC write: write to a temp sibling in the SAME directory (so rename is a
  # cheap same-filesystem op), then rename over the target. The target is never
  # observed truncated/partial — a disk-full or crash mid-write leaves the temp
  # file (cleaned up) and the original intact. The target's existing FILE MODE is
  # preserved (a fresh temp would otherwise default to the umask, silently
  # dropping an executable bit on a script/hook).
  defp gate_write(path, src) do
    tmp = path <> ".code-edit.#{System.unique_integer([:positive])}.tmp"

    # FUP-027: snapshot the target's PRIOR state into the program-scoped restore
    # journal BEFORE overwriting, so a later (fail …) in the enclosing program
    # rolls this write back. A no-op when no journal scope is active (a bare write
    # keeps the pre-FUP-027 behaviour). Captured before the rename, while the old
    # bytes still exist.
    Journal.record(%{path: path, prior: prior_state(path)})

    with :ok <- File.write(tmp, src),
         :ok <- preserve_mode(path, tmp),
         :ok <- File.rename(tmp, path) do
      :ok
    else
      {:error, reason} ->
        _ = File.rm(tmp)
        {:error, "code-edit: write failed (#{:file.format_error(reason)})"}
    end
  end

  # The target's prior state for the rollback journal: its current bytes, or
  # `:absent` when the target does not yet exist (a fresh create — rollback then
  # deletes it). Best-effort: an unreadable target records `:absent` so a failed
  # program at worst removes a file it could not snapshot, never crashes the write.
  defp prior_state(path) do
    case File.read(path) do
      {:ok, bytes} -> {:bytes, bytes}
      {:error, _} -> :absent
    end
  end

  # Copy the target's mode onto the temp file so the rename preserves permissions.
  # If the target does not exist (a new file) or cannot be stat'd, leave the temp
  # at its default mode — a missing target has no mode to preserve.
  defp preserve_mode(path, tmp) do
    case File.stat(path) do
      {:ok, %File.Stat{mode: mode}} -> File.chmod(tmp, mode)
      {:error, :enoent} -> :ok
      {:error, reason} -> {:error, reason}
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
