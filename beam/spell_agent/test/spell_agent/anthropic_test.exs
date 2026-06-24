defmodule SpellAgent.AnthropicTest do
  use ExUnit.Case, async: true

  alias SpellAgent.Anthropic

  # Build an SSE body from a list of event maps (encoded with Jason so we never
  # hand-escape nested JSON).
  defp sse(events) do
    events
    |> Enum.map(fn ev -> "data: " <> Jason.encode!(ev) end)
    |> Enum.join("\n\n")
  end

  describe "build_body/2 — subscription adaptations" do
    test "prepends billing + identity system blocks and keeps the user system prompt" do
      body = Anthropic.build_body("claude-sonnet-4", %{system: "You are helpful.", messages: []})

      blocks = body["system"]
      assert is_list(blocks)
      assert length(blocks) == 3

      [billing, identity, user] = blocks
      assert billing["text"] =~ "x-anthropic-billing-header:"
      assert billing["text"] =~ "cc_version=2.1.63."
      assert billing["text"] =~ "cc_entrypoint=cli"
      assert billing["text"] =~ ~r/cch=[0-9a-f]{5};/
      assert identity["text"] == "You are a Claude agent, built on Anthropic's Claude Agent SDK."
      assert user["text"] == "You are helpful."
    end

    test "does NOT inject Claude Code blocks for 3-5-haiku models" do
      body = Anthropic.build_body("claude-3-5-haiku-latest", %{system: "Hi", messages: []})
      # No Claude Code billing/identity blocks for 3-5-haiku; only the user block
      # remains (the cache-control cap may mark it, which is expected).
      assert [%{"type" => "text", "text" => "Hi"}] = body["system"]
      refute Enum.any?(body["system"], &(&1["text"] =~ "Claude Agent SDK"))
      refute Enum.any?(body["system"], &(&1["text"] =~ "x-anthropic-billing-header"))
    end

    test "prefixes tool names with proxy_ on the wire" do
      body =
        Anthropic.build_body("claude-sonnet-4", %{
          system: "s",
          messages: [],
          tools: [%{name: "find", description: "d", parameters: %{properties: %{}, required: []}}]
        })

      assert [%{"name" => "proxy_find", "input_schema" => schema}] = body["tools"]
      assert schema["type"] == "object"
    end

    test "sets stream + a positive max_tokens and the model" do
      body = Anthropic.build_body("claude-sonnet-4", %{system: "s", messages: []})
      assert body["model"] == "claude-sonnet-4"
      assert body["stream"] == true
      assert is_integer(body["max_tokens"]) and body["max_tokens"] > 0
    end

    test "caps cache_control breakpoints at 4" do
      blocks =
        for i <- 1..6,
            do: %{"type" => "text", "text" => "b#{i}", "cache_control" => %{"type" => "ephemeral"}}

      body = Anthropic.build_body("claude-3-5-haiku-x", %{system: blocks, messages: []})
      kept = Enum.count(body["system"], &Map.has_key?(&1, "cache_control"))
      assert kept <= 4
    end
  end

  describe "tool_result is_error flag (BUG-014)" do
    # A rejected tool returns %{"err" => _}; the shared Hist.Result.error?/1
    # classifier must flag the tool_result block so the model cannot narrate past
    # a rejection as if it succeeded. Content reaches here as a JSON binary.
    test "a rejected tool result is flagged is_error on the tool_result block" do
      body =
        Anthropic.build_body("claude-sonnet-4", %{
          messages: [
            %{role: :tool, tool_call_id: "t1", content: Jason.encode!(%{"err" => "bad layout"})}
          ]
        })

      [block] = hd(body["messages"])["content"]
      assert block["type"] == "tool_result"
      assert block["is_error"] == true
    end

    test "a normal tool result is not flagged" do
      body =
        Anthropic.build_body("claude-sonnet-4", %{
          messages: [
            %{role: :tool, tool_call_id: "t1", content: Jason.encode!(%{"text" => "ok"})}
          ]
        })

      [block] = hd(body["messages"])["content"]
      refute Map.has_key?(block, "is_error")
    end
  end

  describe "tool prefix helpers" do
    test "apply/strip round-trip" do
      assert Anthropic.apply_tool_prefix("find") == "proxy_find"
      assert Anthropic.apply_tool_prefix("proxy_find") == "proxy_find"
      assert Anthropic.strip_tool_prefix("proxy_find") == "find"
      assert Anthropic.strip_tool_prefix("find") == "find"
      assert Anthropic.apply_tool_prefix(nil) == nil
    end
  end

  describe "parse_response/1 — SSE folding" do
    test "accumulates text deltas into content" do
      body =
        sse([
          %{"type" => "message_start", "message" => %{"usage" => %{"input_tokens" => 10, "output_tokens" => 0}}},
          %{"type" => "content_block_start", "index" => 0, "content_block" => %{"type" => "text", "text" => ""}},
          %{"type" => "content_block_delta", "index" => 0, "delta" => %{"type" => "text_delta", "text" => "Hello"}},
          %{"type" => "content_block_delta", "index" => 0, "delta" => %{"type" => "text_delta", "text" => " world"}},
          %{"type" => "message_delta", "usage" => %{"output_tokens" => 2}}
        ])

      assert %{content: "Hello world", tokens: tokens} = Anthropic.parse_response(body)
      assert tokens.input == 10
      assert tokens.output == 2
    end

    test "assembles a streamed tool_use block into tool_calls (prefix stripped)" do
      program_json = Jason.encode!(%{"program" => "(+ 1 1)"})

      body =
        sse([
          %{"type" => "content_block_start", "index" => 0, "content_block" => %{"type" => "tool_use", "id" => "t1", "name" => "proxy_lisp_eval", "input" => %{}}},
          %{"type" => "content_block_delta", "index" => 0, "delta" => %{"type" => "input_json_delta", "partial_json" => program_json}}
        ])

      assert %{tool_calls: [call]} = Anthropic.parse_response(body)
      assert call.name == "lisp_eval"
      assert call.id == "t1"
      assert call.args == %{"program" => "(+ 1 1)"}
    end

    test "non-SSE full message object fallback" do
      obj = %{
        "content" => [%{"type" => "text", "text" => "hi"}],
        "usage" => %{"input_tokens" => 3, "output_tokens" => 1}
      }

      assert %{content: "hi", tokens: %{input: 3, output: 1}} = Anthropic.parse_response(obj)
    end
  end

  # Live tests hit the real Anthropic subscription using the credential in
  # ~/.spell/agent/agent.db. Excluded by default; run with `mix test --include live`.
  describe "live subscription [requires agent.db + network]" do
    @describetag :live

    setup do
      case SpellAgent.Credentials.load("anthropic") do
        {:ok, _} -> :ok
        {:error, reason} -> {:skip, "no anthropic credential: #{inspect(reason)}"}
      end
    end

    test "direct call returns content" do
      req = %{system: "You are concise.", messages: [%{"role" => "user", "content" => "Reply with exactly: pong"}]}
      assert {:ok, %{content: content}} = SpellAgent.Anthropic.call("claude-sonnet-4-5-20250929", req)
      assert is_binary(content) and content != ""
    end

    test "drives a SubAgent single-shot end to end" do
      llm = SpellAgent.Anthropic.callback("claude-sonnet-4-5-20250929")
      assert {:ok, step} = PtcRunner.SubAgent.run("What is 17 + 25? Reply with just the number.", llm: llm, max_turns: 1)
      assert step.return in [42, "42"]
    end
  end
end
