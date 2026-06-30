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
  @default_max_tokens 8192

  # A single ephemeral cache breakpoint marker. Anthropic allows <= 4 of these
  # per request; placement is in apply_cache_control_cap/1 (PLAN-018 W1).
  @ephemeral %{"type" => "ephemeral"}
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
      # Seed the cch digest on the STABLE system prompt TEXT ONLY — never the
      # growing message tape, and never the block METADATA. The billing block
      # sits at system position 0, before the cached prefix; if its bytes change
      # turn-over-turn the whole prefix cache is invalidated from token 0. We
      # hash only the rendered text so that caller-set cache_control marks (which
      # this adapter strips and re-places downstream) do not perturb the digest.
      # (TS reference seeds on systemPromptText for the same reason.) (PLAN-018 W1.)
      digest_seed = %{"system" => system_seed_text(Map.get(request, :system))}

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

  # Render the system prompt to the STABLE text the cch digest hashes: a string
  # passes through; a block list contributes its text fields only (string or
  # atom keyed), so caller-set cache_control metadata never perturbs the digest.
  defp system_seed_text(text) when is_binary(text), do: text

  defp system_seed_text(blocks) when is_list(blocks) do
    blocks
    |> Enum.map(fn b -> (is_map(b) && (Map.get(b, "text") || Map.get(b, :text))) || "" end)
    |> Enum.join("\n")
  end

  defp system_seed_text(other), do: other

  # "x-anthropic-billing-header: cc_version=<ver>.<rand3>; cc_entrypoint=cli; cch=<sha256(seed)[0..4]>;"
  defp billing_header(seed) do
    payload = Jason.encode!(seed)
    cch = :crypto.hash(:sha256, payload) |> Base.encode16(case: :lower) |> binary_part(0, 5)

    # The build-hash suffix is DETERMINISTIC (derived from the version), not a
    # per-call random. A random suffix would change the position-0 billing block
    # every turn and invalidate the entire prefix cache; a real Claude Code build
    # hash is itself stable per build, so a stable value is also more faithful
    # mimicry. (PLAN-018 W1.)
    build_hash =
      :crypto.hash(:sha256, @claude_code_version) |> Base.encode16(case: :lower) |> binary_part(0, 3)

    "x-anthropic-billing-header: cc_version=#{@claude_code_version}.#{build_hash}; cc_entrypoint=cli; cch=#{cch};"
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

  # Prompt-cache breakpoint placement (PLAN-018 W1). Anthropic allows <= 4
  # `cache_control` breakpoints; we place a ROLLING set so the growing prefix is
  # re-read at the ~0.1x cache-read price instead of full price every turn:
  #
  #   1. last tools block     — the tool schema, stable across the whole session
  #   2. last system block    — the system prompt, stable
  #   3. penultimate user msg —\ the two most-recent user turns; this pair rolls
  #   4. last user msg        —/ forward each turn, anchoring the tail delta.
  #
  # The two MESSAGE breakpoints are what was missing before: only the system
  # block was cached, so the entire message tape was re-read at full price. By
  # construction we place at most 1+1+2 = 4. Any caller-set cache_control is
  # cleared first so placement is deterministic and the <=4 cap cannot be
  # exceeded. Ported from packages/ai/src/providers/anthropic.ts
  # applyPromptCaching.
  defp apply_cache_control_cap(body) do
    body
    |> clear_all_cache_control()
    |> mark_last("tools")
    |> mark_last("system")
    |> mark_recent_users()
  end

  defp clear_all_cache_control(body) do
    body
    |> maybe_update_list("system", fn blocks -> Enum.map(blocks, &drop_cache_control/1) end)
    |> maybe_update_list("tools", fn tools -> Enum.map(tools, &drop_cache_control/1) end)
    |> maybe_update_list("messages", fn msgs -> Enum.map(msgs, &clear_message_cache/1) end)
  end

  defp clear_message_cache(%{"content" => content} = msg) when is_list(content) do
    %{msg | "content" => Enum.map(content, &drop_cache_control/1)}
  end

  defp clear_message_cache(msg), do: msg

  # Strip a cache_control breakpoint regardless of key style. Caller-supplied
  # blocks may be atom-keyed (:cache_control) while this adapter writes string
  # keys; a surviving atom-keyed mark would let total breakpoints exceed the
  # Anthropic <=4 cap (and duplicate the key on JSON encode). (PLAN-018 W1, S1
  # swarm finding.)
  defp drop_cache_control(block) when is_map(block) do
    block |> Map.delete("cache_control") |> Map.delete(:cache_control)
  end

  defp drop_cache_control(block), do: block

  # Mark the last block of a top-level list field (system blocks or tool defs).
  defp mark_last(body, key) do
    maybe_update_list(body, key, fn blocks ->
      List.update_at(blocks, length(blocks) - 1, &Map.put(&1, "cache_control", @ephemeral))
    end)
  end

  # Roll the tail breakpoints forward onto the two most-recent user messages.
  defp mark_recent_users(body) do
    maybe_update_list(body, "messages", fn msgs ->
      targets =
        msgs
        |> Enum.with_index()
        |> Enum.filter(fn {m, _} -> Map.get(m, "role") == "user" end)
        |> Enum.map(&elem(&1, 1))
        |> Enum.reverse()
        |> Enum.take(2)

      Enum.reduce(targets, msgs, fn idx, acc -> List.update_at(acc, idx, &mark_user_message/1) end)
    end)
  end

  defp mark_user_message(%{"content" => content} = msg) when is_binary(content) do
    %{msg | "content" => [%{"type" => "text", "text" => content, "cache_control" => @ephemeral}]}
  end

  defp mark_user_message(%{"content" => content} = msg) when is_list(content) and content != [] do
    %{msg | "content" => mark_last_text_block(content)}
  end

  defp mark_user_message(msg), do: msg

  # Prefer the last TEXT block; fall back to the last block (parity with the TS
  # applyCacheControlToLastTextBlock helper). A tool_result block is a valid
  # cache_control carrier, so the fallback is sound.
  defp mark_last_text_block(blocks) do
    last_text_idx =
      blocks
      |> Enum.with_index()
      |> Enum.reverse()
      |> Enum.find_value(fn {b, i} -> if Map.get(b, "type") == "text", do: i end)

    idx = last_text_idx || length(blocks) - 1
    List.update_at(blocks, idx, &Map.put(&1, "cache_control", @ephemeral))
  end

  defp maybe_update_list(body, key, fun) do
    case Map.get(body, key) do
      list when is_list(list) and list != [] -> Map.put(body, key, fun.(list))
      _ -> body
    end
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
