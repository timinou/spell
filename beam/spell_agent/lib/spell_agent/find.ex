defmodule SpellAgent.Find do
  @moduledoc """
  Native `find` / `find-edges` / `edit` tools backed by the Rust kernel NIF
  (PLAN-025 W4, FEAT-042).

  The `PiKernelNif` (pi-code-engine / pi-code-path) already hosts the structural
  primitives the code-* tools use for parse/unparse; this module wires the
  remaining three as agent-callable verbs:

    * `find`        — resolve a CodePath (`<file>`, `<glob>`, `<file>::<symbol>`,
      slices, `#qualifier`s) to its nodes. The symbol-aware navigation surface.
    * `find-edges`  — resolve a graph-edge query (`Sym def→` callers, `ref→`
      definition, `implements→`, `inherits→`, …) to the connected nodes.
    * `edit`        — apply ONE structural edit action to a target, committed
      through the warm buffer registry's transaction (cross-runtime coordinated).

  ## Trust + safety boundary (BUG-028)

  A raw NIF call is NOT inside the PTC sandbox, so a pathological input (a huge
  source blob, a malformed target) could otherwise trap the tool call or run
  unbounded. Every entry here:

    * BOUNDS the input first — a target/action over `@max_input_bytes` is rejected
      with a clear error BEFORE the NIF is touched (a cheap size gate, not a hang).
    * WRAPS the NIF in try/rescue/catch so a `:nif_not_loaded`, a decode failure,
      or any panic degrades to an `%{"error" => _}` map — the tool NEVER crashes
      the agent (the same posture as `SpellAgent.Code.safe_parse/2`).

  The kernel itself runs the parse/resolve on a dirty scheduler, so a slow NIF
  call does not block the BEAM's normal schedulers; the size gate is the guard
  against pathologically large WORK before that point.
  """

  alias SpellAgent.Hist

  # A target/action string over this size is rejected before the NIF call. Chosen
  # generously (a large CodePath or edit action is still small); the point is to
  # reject a megabyte-scale pathological input, not to constrain normal use.
  @max_input_bytes 65_536

  @doc """
  The `find` tool fn: resolve a CodePath `:target` (rooted at `:root`, default
  ".") to `%{"nodes" => [...], "diagnostics" => [...]}`, or an `%{"error" => _}`
  map. `:root` scopes the resolution to a directory.
  """
  @spec find_tool(map()) :: map()
  def find_tool(args) when is_map(args) do
    with {:ok, target} <- require_bounded(args, "target"),
         {:ok, root} <- bounded_root(args) do
      safe_nif(fn -> PiKernelNif.resolve(target, root) end, "find")
    else
      {:error, msg} -> %{"error" => msg}
    end
  end

  @doc """
  The `find-edges` tool fn: resolve a graph-edge query `:target` (e.g.
  `"foo.ex::bar def→"`) to the connected nodes, or an `%{"error" => _}` map.
  """
  @spec find_edges_tool(map()) :: map()
  def find_edges_tool(args) when is_map(args) do
    with {:ok, target} <- require_bounded(args, "target"),
         {:ok, root} <- bounded_root(args) do
      safe_nif(fn -> PiKernelNif.resolve_edges_decoded(target, root) end, "find-edges")
    else
      {:error, msg} -> %{"error" => msg}
    end
  end

  @doc """
  The `edit` tool fn: apply ONE structural edit `:action` (a JSON string, or a
  map that is JSON-encoded here) to `:target`, attributed to the current session.
  Returns `%{"edit_count" => N, "revision" => R, "targetSummary" => "…"}` or an
  `%{"error" => _}` map.

  The write commits through the kernel's warm-buffer transaction, coordinated
  cross-runtime with the NAPI peer via the same broker (no split-brain).
  """
  @spec edit_tool(map(), String.t()) :: map()
  def edit_tool(args, session_id \\ "") when is_map(args) do
    with {:ok, target} <- require_bounded(args, "target"),
         :ok <- workspace_safe(target),
         {:ok, action_json} <- require_action(args) do
      safe_nif(fn -> PiKernelNif.apply_edit_decoded(session_id, target, action_json) end, "edit")
    else
      {:error, msg} -> %{"error" => msg}
    end
  end

  # --- helpers ---------------------------------------------------------------

  # Wrap a NIF call: decode its {:ok, map} | {:error, reason}, and turn ANY raise
  # or unexpected shape into a clean %{"error" => _} map so a bad/missing NIF or a
  # panic never crashes the agent.
  defp safe_nif(fun, label) do
    case fun.() do
      {:ok, %{} = map} -> map
      {:ok, other} -> %{"error" => "#{label}: unexpected result #{inspect(other)}"}
      {:error, reason} -> %{"error" => "#{label}: #{format_reason(reason)}"}
      other -> %{"error" => "#{label}: unexpected #{inspect(other)}"}
    end
  rescue
    e -> %{"error" => "#{label}: NIF unavailable (#{Exception.message(e)})"}
  catch
    kind, reason -> %{"error" => "#{label}: NIF #{kind} (#{inspect(reason)})"}
  end

  defp require_bounded(args, key) do
    case Map.get(args, key) || Map.get(args, safe_atom(key)) do
      v when is_binary(v) and byte_size(v) <= @max_input_bytes ->
        {:ok, v}

      v when is_binary(v) ->
        {:error, "#{key} exceeds #{@max_input_bytes} bytes"}

      _ ->
        {:error, "#{key} is required (a string)"}
    end
  end

  # The `:root` scoping arg (review S4 P1): bound it like any NIF input — a
  # megabyte-scale root would otherwise reach the NIF unchecked. Defaults to ".".
  defp bounded_root(args) do
    case Map.get(args, "root") || Map.get(args, safe_atom("root")) do
      nil -> {:ok, "."}
      v when is_binary(v) and byte_size(v) <= @max_input_bytes -> {:ok, v}
      v when is_binary(v) -> {:error, "root exceeds #{@max_input_bytes} bytes"}
      _ -> {:error, "root must be a string"}
    end
  end

  # Edit path safety (review S4 P1): `edit` commits a real file write via the
  # kernel, so the target's FILE part must stay inside the workspace. Reject an
  # absolute path or any `..` traversal segment before the NIF touches the disk.
  # The target is `<file>` or `<file>::<symbol>` — guard the file part.
  defp workspace_safe(target) do
    file = target |> String.split("::", parts: 2) |> List.first() |> to_string()

    cond do
      file == "" ->
        {:error, "edit target has no file part"}

      # absolute path (unix `/...` or windows `C:\...`) escapes the workspace.
      String.starts_with?(file, "/") or Regex.match?(~r/^[a-zA-Z]:[\\\/]/, file) ->
        {:error, "edit target must be a workspace-relative path (got absolute #{inspect(file)})"}

      # any `..` path segment can climb out of the workspace.
      ".." in Path.split(file) ->
        {:error, "edit target must not contain `..` (path traversal): #{inspect(file)}"}

      true ->
        :ok
    end
  end

  # The edit :action may arrive as a JSON string OR a map (a PTC program builds a
  # data map). Bound BOTH the map's DEPTH/term-size (before JSON encoding, review
  # S4 P2 — a deeply nested map could OOM/CPU-spike Jason.encode) AND the encoded
  # JSON size.
  defp require_action(args) do
    case Map.get(args, "action") || Map.get(args, :action) do
      v when is_binary(v) ->
        if byte_size(v) <= @max_input_bytes,
          do: {:ok, v},
          else: {:error, "action exceeds #{@max_input_bytes} bytes"}

      v when is_map(v) ->
        # Cheap term-size guard BEFORE encoding: external_size is O(term) and
        # bounds the work Jason.encode would do, so a pathological map is rejected
        # without paying the encode.
        if :erlang.external_size(v) > @max_input_bytes do
          {:error, "action exceeds #{@max_input_bytes} bytes"}
        else
          case Jason.encode(v) do
            {:ok, json} when byte_size(json) <= @max_input_bytes -> {:ok, json}
            {:ok, _} -> {:error, "action exceeds #{@max_input_bytes} bytes"}
            {:error, _} -> {:error, "action is not JSON-encodable"}
          end
        end

      _ ->
        {:error, "action is required (a JSON string or a map)"}
    end
  end

  defp format_reason(reason) when is_binary(reason), do: reason
  defp format_reason(reason), do: inspect(reason)

  # Never mint a new atom from an arg key (atom-table safety); resolve to an
  # existing atom or fall back to the string lookup miss.
  defp safe_atom(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> :__nonexistent__
  end

  @doc false
  # A default session id for the edit attribution when the tool is called outside
  # a session context (the registry-tools path binds the real one).
  def default_session, do: Hist.new_session_id()
end
