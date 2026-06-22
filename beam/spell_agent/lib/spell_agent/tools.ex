defmodule SpellAgent.Tools do
  @moduledoc """
  The homoiconic tool surface (FEAT-826, PLAN-344).

  Builds the `tools` map that `PtcRunner.SubAgent` hands to the PTC-Lisp
  evaluator, where every entry is a `(args_map -> value)` function (the verified
  `invoke_tool` contract). Two kinds of entry live in `SpellAgent.ToolRegistry`:

    * `:native` — an Elixir function (the `define-*` meta-tools, plus any
      built-ins we wire in later such as a NIF-backed `find`).
    * `:ptc`    — PTC-Lisp SOURCE TEXT authored at runtime. This is the
      homoiconic core: a tool the agent writes is stored as data, then RE-RUN
      through the same sandboxed `PtcRunner.Lisp.run/2` the `execute` tool uses,
      with the call's args bound as `data/<param>`.

  The meta-tools (`define-tool`, `define-config`, `list-tools`) are themselves
  native entries, so the agent invokes them as ordinary `(tool/define-tool …)`
  calls from inside a program.

  ## Why stored source, not a captured closure

  A defined tool is code-as-data: durable, diffable, inspectable, and re-runnable
  — the W4 "stored program" vision. Storing an Elixir closure would lose all of
  that and couldn't be shown back to the agent via `list-tools`. The cost is one
  parse + sandboxed run per invocation, which is exactly the `execute` path's
  cost and carries all its safety machinery (heap caps, tool-call limits).
  """

  alias SpellAgent.{Config, ToolRegistry}

  @doc """
  Build the name → `(args -> value)` map for SubAgent, from the registry plus
  the always-present meta-tools.
  """
  @spec build_tools_map() :: %{optional(String.t()) => (map() -> term())}
  def build_tools_map do
    registry_tools =
      ToolRegistry.all()
      |> Map.new(fn entry -> {entry.name, to_callable(entry)} end)

    meta_tools()
    |> Map.merge(native_tools())
    |> Map.merge(freeform_tools())
    |> Map.merge(registry_tools)
  end

  # Built-in native tools that are not meta-tools (define-*) and not part of the
  # freeform render surface. `sh` runs an argv vector on brush (PLAN-011 W1).
  defp native_tools do
    %{
      "sh" => &SpellAgent.Sh.tool/1,
      "sh-pipe" => &SpellAgent.Sh.pipe_tool/1,
      "sh-parse" => &SpellAgent.Sh.parse_tool/1,
      "sh-unparse" => &SpellAgent.Sh.unparse_tool/1
    }
  end

  # The freeform render-mirror surface (PLAN-009): view/ builders, theme/ palette,
  # layout/ slot ops, and lens/ tree traversals. Registered as ordinary tool-map
  # entries (the ptc_runner PATCH-O namespaces route ns/verb to these qualified
  # names). lens/ closes over the LIVE layout tree so a traversal called with `{}`
  # acts on the current UI. Degrades to no freeform tools if the registries aren't
  # running (e.g. a bare unit test), so the agent surface never crashes to build.
  defp freeform_tools do
    SpellAgent.Tui.View.tools()
    |> Map.merge(SpellAgent.Tui.LayoutRegistry.tools())
    |> Map.merge(SpellAgent.Tui.Lens.tools(SpellAgent.Tui.LayoutRegistry.tree()))
    |> Map.merge(SpellAgent.Tui.Cell.Verb.tools())
  rescue
    _ -> %{}
  catch
    :exit, _ -> %{}
  end

  @doc """
  Tool inventory as data (for `list-tools` and for rendering the system prompt):
  a list of `%{"name","params","doc","kind"}` maps, meta-tools first.
  """
  @spec inventory() :: [map()]
  def inventory do
    meta = [
      %{
        "name" => "define-tool",
        "params" => ["name", "params", "doc", "source", "scope"],
        "doc" =>
          "Define a new tool whose body is a PTC-Lisp program (code-as-data). " <>
            "scope \"durable\" persists it across sessions (default \"session\", in-memory).",
        "kind" => "native"
      },
      %{
        "name" => "define-config",
        "params" => ["key", "value"],
        "doc" => "Set a live config value (e.g. model, thinking, system-addendum).",
        "kind" => "native"
      },
      %{
        "name" => "list-tools",
        "params" => [],
        "doc" => "List all tools currently available, including ones defined at runtime.",
        "kind" => "native"
      },
      %{
        "name" => "sh",
        "params" => ["argv", "cwd", "timeout-ms", "env"],
        "doc" =>
          "Run a command as an argv vector on brush; returns %{exit out err lines}. " <>
            "argv is a list of strings (NOT a command string) — inject-proof. " <>
            "e.g. (tool/sh {:argv [\"rg\" \"-l\" \"TODO\" \"lib\"]}).",
        "kind" => "native"
      },
      %{
        "name" => "sh-pipe",
        "params" => ["stages", "cwd", "timeout-ms", "env"],
        "doc" =>
          "Run a byte-pipeline of argv stages on brush (a | b | c); same result " <>
            "shape as sh. stages is a list of argv lists, each inject-proof. " <>
            "e.g. (tool/sh-pipe {:stages [[\"cat\" \"f\"] [\"grep\" \"ERR\"] [\"wc\" \"-l\"]]}).",
        "kind" => "native"
      },
      %{
        "name" => "sh-parse",
        "params" => ["src"],
        "doc" =>
          "Parse a bash string into a walkable PTC-native tree (same shape as Lisp " <>
            "history). e.g. (tool/sh-parse {:src \"rg -l TODO | head\"}).",
        "kind" => "native"
      },
      %{
        "name" => "sh-unparse",
        "params" => ["tree"],
        "doc" =>
          "Render a parsed bash tree back to a bash string (words re-escaped, " <>
            "injection-safe). e.g. (tool/sh-unparse {:tree t}) -> %{bash}.",
        "kind" => "native"
      }
    ]

    defined =
      ToolRegistry.all()
      |> Enum.map(fn e ->
        %{
          "name" => e.name,
          "params" => Enum.map(Map.get(e, :params, []), &to_string/1),
          "doc" => Map.get(e, :doc, ""),
          "kind" => to_string(e.kind)
        }
      end)

    meta ++ defined
  end

  # --- meta-tools (native) ---------------------------------------------------

  defp meta_tools do
    %{
      "define-tool" => &define_tool/1,
      "define-config" => &define_config/1,
      "list-tools" => fn _args -> inventory() end
    }
  end

  @doc """
  `(tool/define-tool {:name "x" :params [:a :b] :doc "…" :source "<ptc>"})`.

  Validates the PTC source parses, then registers it. Returns a small data map
  the agent can read back; raises with a clear message on a bad definition (the
  `invoke_tool` contract turns the raise into an LLM-facing error payload).
  """
  @spec define_tool(map()) :: map()
  def define_tool(args) do
    name = require_string(args, "name")
    source = require_string(args, "source")
    params = args |> flex_get("params") |> normalize_params()
    doc = args |> flex_get("doc") |> to_doc()

    if reserved_name?(name) do
      raise ArgumentError, "cannot redefine reserved tool #{inspect(name)}"
    end

    scope = normalize_scope(flex_get(args, "scope"))

    case validate_source(source) do
      :ok ->
        ToolRegistry.put(%{
          kind: :ptc,
          name: name,
          params: params,
          doc: doc,
          source: source,
          scope: scope
        })

        %{
          "ok" => true,
          "defined" => name,
          "params" => Enum.map(params, &to_string/1),
          "scope" => to_string(scope)
        }

      {:error, reason} ->
        raise ArgumentError, "define-tool #{inspect(name)} has invalid PTC source: #{reason}"
    end
  end

  @doc """
  `(tool/define-config {:key "model" :value "…"})` — set a live config cell.
  """
  @spec define_config(map()) :: map()
  def define_config(args) do
    key = require_string(args, "key")
    value = flex_get(args, "value")

    case Config.put(key, value) do
      :ok -> %{"ok" => true, "set" => key, "value" => value}
      {:error, reason} -> raise ArgumentError, "define-config rejected #{inspect(key)}: #{reason}"
    end
  end

  # --- entry → callable ------------------------------------------------------

  # A :native entry already carries its fn. A :ptc entry becomes a closure that
  # runs the stored source with the call args bound as data/<param>.
  defp to_callable(%{kind: :native, fun: fun}), do: fun

  defp to_callable(%{kind: :ptc, name: name, source: source}) do
    fn args ->
      context = stringify_keys(args)

      case PtcRunner.Lisp.run(source,
             context: context,
             tools: build_tools_map(),
             caller: :in_process_v1
           ) do
        {:ok, step} ->
          step.return

        {:error, step} ->
          # Surface the program failure as a raise so invoke_tool renders an
          # LLM-facing error payload (consistent with native tool failures).
          raise "defined tool #{inspect(name)} failed: #{inspect(step.fail || step.return)}"
      end
    end
  end

  # --- validation + helpers --------------------------------------------------

  # Reject malformed definitions at define time (not at first call).
  defp validate_source(source) do
    # Use the runner's own bounded validator: parse + analyze + undefined-var
    # check, all under a heap/timeout cap. `data/<param>` references are a
    # recognized special form, not free vars, so a tool body that reads its
    # params validates cleanly. Returns :ok | {:error, [messages]}.
    case PtcRunner.Lisp.validate(source) do
      :ok -> :ok
      {:error, messages} -> {:error, Enum.join(List.wrap(messages), "; ")}
    end
  end

  defp reserved_name?(name),
    do:
      name in [
        "define-tool",
        "define-config",
        "list-tools",
        "sh",
        "sh-pipe",
        "sh-parse",
        "sh-unparse"
      ]

  defp require_string(args, key) do
    case flex_get(args, key) do
      s when is_binary(s) and s != "" -> s
      other -> raise ArgumentError, "#{key} must be a non-empty string, got #{inspect(other)}"
    end
  end

  defp normalize_params(nil), do: []
  defp normalize_params(list) when is_list(list), do: Enum.map(list, &param_atom/1)

  defp normalize_params(other),
    do: raise(ArgumentError, "params must be a list, got #{inspect(other)}")

  defp param_atom(p) when is_atom(p), do: p
  defp param_atom(p) when is_binary(p), do: String.to_atom(p)

  defp param_atom(p),
    do: raise(ArgumentError, "param must be an atom or string, got #{inspect(p)}")

  defp to_doc(nil), do: ""
  defp to_doc(d) when is_binary(d), do: d
  defp to_doc(d), do: to_string(d)

  # Tool persistence scope (PLAN-011 W3). Default `:session` (in-memory, gone on
  # restart); `:durable` mirrors the tool to the history store so it survives.
  # Case-insensitive on strings/atoms so "Durable"/"DURABLE"/:Durable/"true" all
  # resolve to :durable — the agent should never silently lose persistence to a
  # casing variant. `define-tool` echoes the resolved scope so a genuinely
  # unrecognized value (→ :session) is visible in the response.
  defp normalize_scope(:durable), do: :durable
  defp normalize_scope(:session), do: :session
  defp normalize_scope(true), do: :durable

  defp normalize_scope(value) when is_binary(value) do
    case String.downcase(String.trim(value)) do
      "durable" -> :durable
      "true" -> :durable
      _ -> :session
    end
  end

  defp normalize_scope(value) when is_atom(value) and not is_nil(value) do
    value |> Atom.to_string() |> normalize_scope()
  end

  defp normalize_scope(_), do: :session

  # Args arrive with string OR atom keys (and LispKeyword-derived atoms);
  # tolerate both, normalizing to string lookups.
  defp flex_get(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, safe_atom(key))
  end

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {to_string(k), v} end)
  end

  defp stringify_keys(other), do: other
end
