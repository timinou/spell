defmodule SpellAgent.Anthropic do
  @moduledoc """
  Direct Anthropic `/v1/messages` adapter for a Claude Pro/Max SUBSCRIPTION
  (OAuth) credential, implementing the `PtcRunner.LLM` behaviour (FEAT-825,
  PLAN-344).

  Chosen over a `req_llm` plugin because v0 targets ONE provider and full
  request-body control is the stronger foundation — the subscription path needs
  request-body MUTATIONS (system-block injection, tool-name prefixing) that a
  generic client does not do. `req_llm` becomes worthwhile only when porting
  many providers.

  ## The subscription adaptations (ported from packages/ai/src/providers/anthropic.ts)

  Subscription OAuth is NOT just "a different auth header"; the request must
  present as Claude Code:

    1. `authorization: Bearer <token>` (never `x-api-key`) + the Claude Code
       `anthropic-beta` set + `user-agent: claude-cli/<ver> (external, cli)`.
    2. Two system text blocks PREPENDED: a billing header carrying
       `cch=<sha256(body)[0..4]>`, and the identity line
       "You are a Claude agent, built on Anthropic's Claude Agent SDK."
    3. Tool names prefixed `proxy_` on the way OUT, stripped on the way IN.
    4. `metadata.user_id` left unset unless supplied (cloaking is a no-op in v0).
    5. `cache_control` capped at 4 breakpoints.
    6. TLS: plain SNI + default ciphers (verified: no JA3/fingerprint needed).

  ## Transport

  v0 issues a streaming request (`stream: true`, what the subscription endpoint
  expects) but collects the FULL `text/event-stream` body and parses it in one
  pass. Token-by-token forwarding to a UI (`stream/2`) is a later nicety; the
  request itself already streams server-side.
  """

  @behaviour PtcRunner.LLM



  @messages_url "https://api.anthropic.com/v1/messages"
  @anthropic_version "2023-06-01"
  @claude_code_version "2.1.63"
  @tool_prefix "proxy_"
  @max_cache_breakpoints 4
  @default_max_tokens 8192
  @receive_timeout 120_000

  @claude_code_betas [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "token-efficient-tools-2025-02-19"
  ]

  @identity_instruction "You are a Claude agent, built on Anthropic's Claude Agent SDK."

  # --- PtcRunner.LLM behaviour -----------------------------------------------

  @impl true
  @spec call(String.t(), map()) :: {:ok, map()} | {:error, term()}
  def call(model, request) do
    with {:ok, cred} <- SpellAgent.OAuth.ensure_fresh() do
      call_with_token(model, request, cred.access)
    end
  end

  @doc """
  Build a SubAgent-compatible `llm:` callback bound to this adapter + model.

  Mirrors `PtcRunner.LLM.callback/2` shape: returns a 1-arity fn the loop calls
  with the request map.
  """
  @spec callback(String.t()) :: (map() -> {:ok, map()} | {:error, term()})
  def callback(model) do
    fn request ->
      {_stream_fn, clean} = Map.pop(request, :stream)
      call(model, clean)
    end
  end

  # The test seam (FEAT-006, LLM cassettes). Production returns [] so the live
  # request is byte-for-byte unchanged. A test sets
  # `Application.put_env(:spell_agent, :anthropic_req_options, plug: {Req.Test, Name})`
  # (scoped + cleaned up by `SpellAgent.LlmCassette`) to redirect the request
  # through a Req.Test stub that replays a recorded SSE cassette — no network, and
  # the SAME `parse_response/1` path runs on replay. Using app env rather than
  # threading an option keeps the `PtcRunner.LLM` callback signature untouched.
  defp extra_req_options do
    Application.get_env(:spell_agent, :anthropic_req_options, [])
  end

  # --- request construction --------------------------------------------------

  @doc false
  @spec call_with_token(String.t(), map(), String.t()) :: {:ok, map()} | {:error, term()}
  def call_with_token(model, request, access_token) do
    body = build_body(model, request)
    headers = build_headers(access_token, body)

    base_opts = [
      json: body,
      headers: headers,
      receive_timeout: @receive_timeout,
      # Plain TLS: default ciphers + SNI. No fingerprint spoof needed.
      connect_options: [protocols: [:http1]]
    ]

    case Req.post(@messages_url, Keyword.merge(base_opts, extra_req_options())) do
      {:ok, %Req.Response{status: 200, body: raw}} ->
        {:ok, parse_response(raw)}

      {:ok, %Req.Response{status: status, body: raw}} ->
        {:error, {:http_error, status, error_text(raw)}}

      {:error, reason} ->
        {:error, {:transport_error, reason}}
    end
  end

  @doc false
  def build_body(model, request) do
    system_blocks = build_system_blocks(model, request)
    messages = Map.get(request, :messages, [])
    tools = request |> Map.get(:tools, []) |> convert_tools()

    base = %{
      "model" => model,
      "max_tokens" => max_tokens(request),
      "stream" => true,
      "messages" => convert_messages(messages)
    }

    base
    |> put_unless_empty("system", system_blocks)
    |> put_unless_empty("tools", tools)
    |> apply_cache_control_cap()
  end

  # The two Claude-Code system blocks are prepended to the caller's system
  # prompt. The billing block's `cch` is a digest of the request body, so it is
  # computed from the body WITHOUT the billing block, then prepended.
  defp build_system_blocks(model, request) do
    user_system =
      case Map.get(request, :system) do
        nil -> []
        "" -> []
        text when is_binary(text) -> [%{"type" => "text", "text" => text}]
        blocks when is_list(blocks) -> blocks
      end

    if inject_claude_code?(model) do
      digest_seed = %{
        "system" => Map.get(request, :system),
        "messages" => Map.get(request, :messages, [])
      }

      [
        %{"type" => "text", "text" => billing_header(digest_seed)},
        %{"type" => "text", "text" => @identity_instruction}
        | user_system
      ]
    else
      user_system
    end
  end

  defp inject_claude_code?(model), do: not String.starts_with?(model, "claude-3-5-haiku")

  # "x-anthropic-billing-header: cc_version=<ver>.<rand3>; cc_entrypoint=cli; cch=<sha256(seed)[0..4]>;"
  defp billing_header(seed) do
    payload = Jason.encode!(seed)
    cch = :crypto.hash(:sha256, payload) |> Base.encode16(case: :lower) |> binary_part(0, 5)
    rand3 = :crypto.strong_rand_bytes(2) |> Base.encode16(case: :lower) |> binary_part(0, 3)

    "x-anthropic-billing-header: cc_version=#{@claude_code_version}.#{rand3}; cc_entrypoint=cli; cch=#{cch};"
  end

  defp max_tokens(request) do
    case Map.get(request, :max_tokens) do
      n when is_integer(n) and n > 0 -> n
      _ -> @default_max_tokens
    end
  end

  # Tools arrive in OpenAI function-calling shape from SubAgent:
  #   %{"type" => "function", "function" => %{"name", "description", "parameters"}}
  # Unwrap that envelope (tolerating a flat shape too) and emit Anthropic's flat
  # {name, description, input_schema}, prefixing the name with `proxy_`.
  defp convert_tools([]), do: []
  defp convert_tools(tools) when is_list(tools), do: Enum.map(tools, &convert_tool/1)
  defp convert_tools(_), do: []

  defp convert_tool(%{"function" => fun}) when is_map(fun), do: convert_tool(fun)
  defp convert_tool(%{function: fun}) when is_map(fun), do: convert_tool(fun)

  defp convert_tool(tool) when is_map(tool) do
    name = fetch(tool, :name) || fetch(tool, "name")
    desc = fetch(tool, :description) || fetch(tool, "description") || ""

    schema =
      fetch(tool, :parameters) || fetch(tool, "parameters") ||
        fetch(tool, :input_schema) || fetch(tool, "input_schema") || %{}

    %{
      "name" => apply_tool_prefix(name),
      "description" => desc,
      "input_schema" => normalize_schema(schema)
    }
  end

  defp convert_tool(_), do: %{"name" => nil, "description" => "", "input_schema" => normalize_schema(%{})}

  defp normalize_schema(schema) when is_map(schema) do
    %{
      "type" => "object",
      "properties" => fetch(schema, :properties) || fetch(schema, "properties") || %{},
      "required" => fetch(schema, :required) || fetch(schema, "required") || []
    }
  end

  defp normalize_schema(_), do: %{"type" => "object", "properties" => %{}, "required" => []}

  # Convert SubAgent's message stream to Anthropic message params. SubAgent emits
  # three shapes in :tool_call mode (verified in ptc_tool_call.ex):
  #   * %{role: :user|:assistant, content: string}
  #   * %{role: :assistant, content, tool_calls: [%{id, function: %{name, arguments}}]}
  #       -> Anthropic assistant msg with tool_use content blocks
  #   * %{role: :tool, tool_call_id: id, content: json}
  #       -> Anthropic USER msg with a tool_result content block
  # Anthropic has no `tool`/`system` role: tool results ride a user message, and a
  # stray system message folds into user text.
  defp convert_messages(messages) do
    Enum.map(messages, &convert_message/1)
  end

  # assistant turn that issued native tool calls
  defp convert_message(%{role: :assistant, tool_calls: calls} = msg) when is_list(calls) and calls != [] do
    text = Map.get(msg, :content)

    text_blocks =
      if is_binary(text) and text != "", do: [%{"type" => "text", "text" => text}], else: []

    tool_use_blocks =
      Enum.map(calls, fn c ->
        fun = Map.get(c, :function) || Map.get(c, "function") || %{}
        name = Map.get(fun, :name) || Map.get(fun, "name")
        raw_args = Map.get(fun, :arguments) || Map.get(fun, "arguments") || %{}

        %{
          "type" => "tool_use",
          "id" => Map.get(c, :id) || Map.get(c, "id"),
          "name" => apply_tool_prefix(name),
          "input" => decode_args(raw_args)
        }
      end)

    %{"role" => "assistant", "content" => text_blocks ++ tool_use_blocks}
  end

  # tool result -> a user message carrying a tool_result block
  defp convert_message(%{role: :tool, tool_call_id: id} = msg) do
    content = Map.get(msg, :content)

    block = %{
      "type" => "tool_result",
      "tool_use_id" => id,
      "content" => to_result_content(content)
    }

    # A rejected tool (layout/set, cell, clock, mesh, …) returns a `%{"err" => _}`
    # map or `{:error, _}`. Classify it once here and flag the block, so the model
    # cannot narrate past a rejection as if it succeeded (PLAN-017 / BUG-014).
    # `Hist.Result.error?/1` is the single classifier the rest of the system shares.
    block =
      if tool_result_error?(content) do
        Map.put(block, "is_error", true)
      else
        block
      end

    %{"role" => "user", "content" => [block]}
  end

  defp convert_message(%{role: role, content: content}),
    do: convert_message(%{"role" => to_string(role), "content" => content})

  defp convert_message(%{"role" => role} = msg) do
    %{"role" => normalize_role(role), "content" => convert_content(Map.get(msg, "content"))}
  end

  defp normalize_role("system"), do: "user"
  defp normalize_role("tool"), do: "user"
  defp normalize_role(role), do: role

  defp decode_args(args) when is_binary(args) do
    case Jason.decode(args) do
      {:ok, m} -> m
      _ -> %{}
    end
  end

  defp decode_args(args) when is_map(args), do: args
  defp decode_args(_), do: %{}

  defp to_result_content(c) when is_binary(c), do: c
  defp to_result_content(c), do: Jason.encode!(c)

  # A tool result is an error when the conventional error map/tuple is present.
  # `content` is normally a JSON binary (see convert_message), so decode first;
  # a non-decodable binary or a non-error shape classifies as ok.
  defp tool_result_error?(content) do
    SpellAgent.Hist.Result.error?(decode_result_if_binary(content))
  end

  defp decode_result_if_binary(content) when is_binary(content) do
    case Jason.decode(content) do
      {:ok, decoded} -> decoded
      _ -> content
    end
  end

  defp decode_result_if_binary(content), do: content

  defp convert_content(text) when is_binary(text), do: text

  defp convert_content(blocks) when is_list(blocks) do
    Enum.map(blocks, fn
      %{"type" => "tool_use", "name" => name} = b -> Map.put(b, "name", apply_tool_prefix(name))
      %{type: :tool_use, name: name} = b -> b |> stringify_keys() |> Map.put("name", apply_tool_prefix(name))
      block when is_map(block) -> stringify_keys(block)
      other -> other
    end)
  end

  defp convert_content(other), do: other

  # --- response parsing (SSE collected as a full body) -----------------------

  @doc false
  def parse_response(raw) when is_binary(raw) do
    events = parse_sse(raw)
    fold_events(events)
  end

  # Req may already have decoded JSON if the server replied non-SSE; handle map.
  def parse_response(%{} = decoded) do
    fold_message_object(decoded)
  end

  defp parse_sse(raw) do
    raw
    |> String.split("\n")
    |> Enum.flat_map(fn line ->
      case String.trim(line) do
        "data: " <> json ->
          case Jason.decode(json) do
            {:ok, ev} -> [ev]
            _ -> []
          end

        _ ->
          []
      end
    end)
  end

  # Reduce the SSE event stream into the PtcRunner.LLM response shape.
  defp fold_events(events) do
    acc = %{text: "", blocks: %{}, tool_calls: [], tokens: %{}}

    final =
      Enum.reduce(events, acc, fn ev, st ->
        case Map.get(ev, "type") do
          "message_start" ->
            usage = get_in(ev, ["message", "usage"]) || %{}
            %{st | tokens: merge_usage(st.tokens, usage)}

          "content_block_start" ->
            idx = Map.get(ev, "index")
            block = Map.get(ev, "content_block", %{})
            %{st | blocks: Map.put(st.blocks, idx, block)}

          "content_block_delta" ->
            apply_delta(st, ev)

          "message_delta" ->
            usage = Map.get(ev, "usage", %{})
            %{st | tokens: merge_usage(st.tokens, usage)}

          _ ->
            st
        end
      end)

    finalize(final)
  end

  defp apply_delta(st, ev) do
    idx = Map.get(ev, "index")
    delta = Map.get(ev, "delta", %{})

    case Map.get(delta, "type") do
      "text_delta" ->
        %{st | text: st.text <> Map.get(delta, "text", "")}

      "input_json_delta" ->
        partial = Map.get(delta, "partial_json", "")
        update_in(st.blocks[idx], fn b ->
          Map.update(b || %{}, "__partial", partial, &(&1 <> partial))
        end)

      _ ->
        st
    end
  end

  # Assemble tool_use blocks (with accumulated JSON args) into tool_calls.
  defp finalize(st) do
    tool_calls =
      st.blocks
      |> Enum.sort_by(fn {idx, _} -> idx end)
      |> Enum.flat_map(fn {_idx, block} ->
        case Map.get(block, "type") do
          "tool_use" ->
            args = decode_tool_args(block)

            [%{
              id: Map.get(block, "id"),
              name: strip_tool_prefix(Map.get(block, "name")),
              args: args
            }]

          _ ->
            []
        end
      end)

    cond do
      tool_calls != [] ->
        %{tool_calls: tool_calls, content: nil_if_empty(st.text), tokens: st.tokens}

      true ->
        %{content: st.text, tokens: st.tokens}
    end
  end

  defp decode_tool_args(block) do
    case Map.get(block, "__partial") do
      nil ->
        Map.get(block, "input", %{})

      partial ->
        case Jason.decode(partial) do
          {:ok, m} -> m
          _ -> Map.get(block, "input", %{})
        end
    end
  end

  # Non-SSE fallback: a full message object {content: [...], usage: {...}}.
  defp fold_message_object(obj) do
    content = Map.get(obj, "content", [])
    text = content |> Enum.filter(&(Map.get(&1, "type") == "text")) |> Enum.map_join("", &Map.get(&1, "text", ""))

    tool_calls =
      content
      |> Enum.filter(&(Map.get(&1, "type") == "tool_use"))
      |> Enum.map(fn b ->
        %{id: Map.get(b, "id"), name: strip_tool_prefix(Map.get(b, "name")), args: Map.get(b, "input", %{})}
      end)

    tokens = merge_usage(%{}, Map.get(obj, "usage", %{}))

    if tool_calls != [],
      do: %{tool_calls: tool_calls, content: nil_if_empty(text), tokens: tokens},
      else: %{content: text, tokens: tokens}
  end

  # --- headers ---------------------------------------------------------------

  defp build_headers(access_token, _body) do
    [
      {"authorization", "Bearer #{access_token}"},
      {"anthropic-version", @anthropic_version},
      {"anthropic-beta", Enum.join(@claude_code_betas, ",")},
      {"user-agent", "claude-cli/#{@claude_code_version} (external, cli)"},
      {"accept", "text/event-stream"},
      {"content-type", "application/json"}
    ]
  end

  # --- cache control ---------------------------------------------------------

  # Anthropic rejects > 4 cache_control breakpoints. v0 keeps a single
  # breakpoint on the last system block (the stable prefix) and strips any
  # others the caller may have set.
  defp apply_cache_control_cap(%{"system" => blocks} = body) when is_list(blocks) and blocks != [] do
    cleared = Enum.map(blocks, &Map.delete(&1, "cache_control"))
    capped = List.update_at(cleared, length(cleared) - 1, &Map.put(&1, "cache_control", %{"type" => "ephemeral"}))
    %{body | "system" => Enum.take(strip_excess_cache(capped), @max_cache_breakpoints + length(capped))}
  end

  defp apply_cache_control_cap(body), do: body

  defp strip_excess_cache(blocks) do
    {kept, _} =
      Enum.reduce(blocks, {[], 0}, fn b, {acc, n} ->
        if Map.has_key?(b, "cache_control") and n >= @max_cache_breakpoints do
          {[Map.delete(b, "cache_control") | acc], n}
        else
          bump = if Map.has_key?(b, "cache_control"), do: n + 1, else: n
          {[b | acc], bump}
        end
      end)

    Enum.reverse(kept)
  end

  # --- helpers ---------------------------------------------------------------

  @doc false
  def apply_tool_prefix(nil), do: nil
  def apply_tool_prefix(name) when is_binary(name) do
    if String.starts_with?(name, @tool_prefix), do: name, else: @tool_prefix <> name
  end

  @doc false
  def strip_tool_prefix(nil), do: nil
  def strip_tool_prefix(@tool_prefix <> rest), do: rest
  def strip_tool_prefix(name), do: name

  defp fetch(map, key), do: if(is_map(map), do: Map.get(map, key), else: nil)

  defp put_unless_empty(map, _k, []), do: map
  defp put_unless_empty(map, _k, nil), do: map
  defp put_unless_empty(map, k, v), do: Map.put(map, k, v)

  defp nil_if_empty(""), do: nil
  defp nil_if_empty(s), do: s

  defp merge_usage(tokens, usage) do
    %{
      input: usage["input_tokens"] || tokens[:input] || 0,
      output: usage["output_tokens"] || tokens[:output] || 0,
      cache_read: usage["cache_read_input_tokens"] || tokens[:cache_read] || 0,
      cache_creation: usage["cache_creation_input_tokens"] || tokens[:cache_creation] || 0
    }
  end

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {to_string(k), v} end)
  end

  defp error_text(raw) when is_binary(raw), do: String.slice(raw, 0, 500)
  defp error_text(raw), do: inspect(raw, limit: 5)
end
