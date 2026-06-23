defmodule SpellAgent.Sh do
  @moduledoc """
  The `sh` tool: run an argv vector on brush, return a structured value
  (PLAN-011 W1).

  This is the ORCHESTRATOR seam between Lisp and the brush engine. It owns
  validation and the result-map contract; it owns NO shell parsing (that would
  reintroduce the injection surface the NIF was built to avoid) and NO Lisp
  formatting. The command is always an argv VECTOR of strings — never a single
  command string — so a value spliced into argv is exactly one argument,
  delivered verbatim (inject-proof, see `SpellAgent.BrushNif`).

  ## Call shape

  The PTC tool boundary passes named arguments only, so `sh` is called with a
  map carrying `:argv` plus optional opts:

      (tool/sh {:argv ["rg" "-l" "TODO" "lib"]})
      (tool/sh {:argv ["sleep" "5"] :timeout-ms 1000})
      (tool/sh {:argv ["ls"] :cwd "/tmp"})

  The `sh::` reader form (W2) desugars to exactly this shape.

  ## Result

  A string-keyed map so it composes as plain Lisp data:

      %{"exit" => 0, "out" => "…", "err" => "", "lines" => ["…", …]}

  `lines` is `out` split on newlines (trimmed). `json` is NOT auto-parsed; a
  caller does `(json/parse-string (:out r))` when it wants structured output.
  """

  alias SpellAgent.BrushNif

  @default_timeout_ms 30_000
  @max_timeout_ms 600_000

  @type result :: %{required(String.t()) => integer() | String.t() | [String.t()]}

  @doc """
  The native tool fn registered as `sh`. Receives the string-keyed args map
  built by the PTC tool boundary; returns a `t:result/0` map or an error map.

  Never raises for a command-level outcome — validation failures, non-zero
  exits, timeouts, and trapped panics all return data the agent can read.
  """
  @spec tool(map()) :: result() | %{required(String.t()) => term()}
  def tool(args) when is_map(args) do
    with {:ok, argv} <- fetch_argv(args),
         {:ok, opts} <- build_opts(args, "sh") do
      env = fetch_env(args)
      run(argv, env, opts)
    else
      {:error, message} -> %{"error" => message}
    end
  end

  @doc """
  Run a validated argv on brush and shape the result. Public so other modules
  (e.g. the W2 reader path, W4 pipelines) can reuse the result contract without
  going through tool-arg parsing.
  """
  @spec run([String.t()], %{optional(String.t()) => String.t()}, map()) :: result()
  def run(argv, env, opts) do
    argv
    |> BrushNif.run(env, opts)
    |> shape_result()
  end

  @doc """
  The native tool fn registered as `sh-pipe` (PLAN-011 W4).

  Runs a byte-pipeline of argv stages: `(tool/sh-pipe {:stages [["cat" "f"]
  ["grep" "x"] ["wc" "-l"]]})`. brush connects each stage's stdout to the next
  stage's stdin. Each stage is validated and escaped independently (inject-proof
  per stage). Returns the same `t:result/0` shape as `tool/1`; `exit` is the
  pipeline's overall exit (its last stage).

  Pipelines are the BYTE pipe (no intermediate materialization). The VALUE pipe
  — `(->> (sh:: …) :lines (pmap …))` — stays ordinary Lisp; reach for `sh-pipe`
  only when you want stdout streamed stage-to-stage without round-tripping bytes
  through the BEAM.
  """
  @spec pipe_tool(map()) :: result() | %{required(String.t()) => term()}
  def pipe_tool(args) when is_map(args) do
    with {:ok, stages} <- fetch_stages(args),
         {:ok, opts} <- build_opts(args, "sh-pipe") do
      env = fetch_env(args)
      run_pipe(stages, env, opts)
    else
      {:error, message} -> %{"error" => message}
    end
  end

  @doc "Run validated pipeline stages on brush and shape the result."
  @spec run_pipe([[String.t()]], %{optional(String.t()) => String.t()}, map()) :: result()
  def run_pipe(stages, env, opts) do
    stages
    |> BrushNif.pipe(env, opts)
    |> shape_result()
  end

  @doc """
  The native tool fn registered as `sh-parse` (PLAN-011 W5).

  Parses a bash string into a PTC-native `form_tree` tree — the same walkable
  shape Lisp history projects through, so a shell pipeline and a Lisp program
  share one recall layer. `(tool/sh-parse {:src "rg -l TODO | head"})` returns
  the tree map directly (or an `%{"error" => _}` map on a parse error).
  """
  @spec parse_tool(map()) :: map()
  def parse_tool(args) when is_map(args) do
    case Map.get(args, "src") do
      src when is_binary(src) ->
        case BrushNif.parse(src) do
          {:ok, tree} -> tree
          {:error, reason} -> %{"error" => reason}
        end

      _ ->
        %{"error" => "sh-parse: missing required :src (a bash string)"}
    end
  end

  @doc """
  The native tool fn registered as `sh-unparse` (PLAN-011 W5).

  Renders a `form_tree`-shaped tree back into a bash string, re-escaping words so
  the round-trip can never reintroduce shell injection.
  `(tool/sh-unparse {:tree <tree>})` returns `%{"bash" => "…"}` (or an error map).
  """
  @spec unparse_tool(map()) :: map()
  def unparse_tool(args) when is_map(args) do
    case Map.get(args, "tree") do
      tree when is_map(tree) ->
        case BrushNif.unparse(tree) do
          {:ok, bash} -> %{"bash" => bash}
          {:error, reason} -> %{"error" => reason}
        end

      _ ->
        %{"error" => "sh-unparse: missing required :tree (a form_tree map)"}
    end
  end

  # --- validation ------------------------------------------------------------

  defp fetch_argv(args) do
    case Map.get(args, "argv") do
      list when is_list(list) and list != [] ->
        validate_elements(list)

      [] ->
        {:error, "sh: argv must be a non-empty list (got an empty list)"}

      nil ->
        {:error, "sh: missing required :argv (a list of strings)"}

      other ->
        {:error, "sh: argv must be a list of strings, got #{inspect(other, limit: 3)}"}
    end
  end

  # Every element must be a binary with no embedded NUL (the OS/brush cannot
  # carry a NUL in an argument). Reports the offending 0-based index.
  defp validate_elements(list) do
    list
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {el, idx}, {:ok, acc} ->
      cond do
        not is_binary(el) ->
          {:halt, {:error, "sh: argv element #{idx} must be a string, got #{inspect(el)}"}}

        String.contains?(el, <<0>>) ->
          {:halt, {:error, "sh: argv element #{idx} contains a NUL byte"}}

        true ->
          {:cont, {:ok, [el | acc]}}
      end
    end)
    |> case do
      {:ok, reversed} -> {:ok, Enum.reverse(reversed)}
      error -> error
    end
  end

  # A pipeline is a non-empty list of stages, each a non-empty list of strings.
  defp fetch_stages(args) do
    case Map.get(args, "stages") do
      list when is_list(list) and list != [] ->
        validate_stages(list)

      [] ->
        {:error, "sh-pipe: stages must be a non-empty list (got an empty list)"}

      nil ->
        {:error, "sh-pipe: missing required :stages (a list of argv lists)"}

      other ->
        {:error, "sh-pipe: stages must be a list of argv lists, got #{inspect(other, limit: 3)}"}
    end
  end

  defp validate_stages(list) do
    list
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {stage, idx}, {:ok, acc} ->
      case stage do
        s when is_list(s) and s != [] ->
          case validate_elements(s) do
            {:ok, valid} -> {:cont, {:ok, [valid | acc]}}
            {:error, msg} -> {:halt, {:error, "sh-pipe stage #{idx}: #{msg}"}}
          end

        _ ->
          {:halt, {:error, "sh-pipe: stage #{idx} must be a non-empty list of strings"}}
      end
    end)
    |> case do
      {:ok, reversed} -> {:ok, Enum.reverse(reversed)}
      error -> error
    end
  end

  defp build_opts(args, label) do
    with {:ok, timeout} <- fetch_timeout(args, label) do
      opts = %{"timeout_ms" => timeout}
      opts = maybe_put_cwd(opts, args)
      {:ok, opts}
    end
  end

  defp fetch_timeout(args, label) do
    # Accept both "timeout-ms" (Lisp kebab) and "timeout_ms".
    case Map.get(args, "timeout-ms") || Map.get(args, "timeout_ms") do
      nil ->
        {:ok, @default_timeout_ms}

      n when is_integer(n) and n > 0 ->
        {:ok, min(n, @max_timeout_ms)}

      other ->
        {:error, "#{label}: timeout-ms must be a positive integer, got #{inspect(other)}"}
    end
  end

  defp maybe_put_cwd(opts, args) do
    case Map.get(args, "cwd") do
      cwd when is_binary(cwd) and cwd != "" -> Map.put(opts, "cwd", cwd)
      _ -> opts
    end
  end

  # Optional environment overrides: a map of string=>string under :env.
  defp fetch_env(args) do
    case Map.get(args, "env") do
      env when is_map(env) ->
        for {k, v} <- env, is_binary(k) and is_binary(v), into: %{}, do: {k, v}

      _ ->
        %{}
    end
  end

  # --- result shaping --------------------------------------------------------

  defp shape_result(%{"out" => out} = nif_result) do
    nif_result
    |> Map.put("lines", String.split(out, "\n", trim: true))
  end

  # Defensive: if the NIF ever returns a shape without "out", surface it as-is
  # rather than crashing the tool boundary.
  defp shape_result(other), do: other
end
