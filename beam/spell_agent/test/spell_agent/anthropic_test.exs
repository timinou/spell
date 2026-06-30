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

  # The cost win: the growing message tape must be re-read at the cache-read
  # price, not full price, every turn. That requires (a) a byte-stable cached
  # prefix — the position-0 billing block cannot change turn-over-turn — and
  # (b) rolling breakpoints on the message tail, which were entirely absent
  # before. (PLAN-018 W1.)
  describe "prompt-cache breakpoint placement (PLAN-018 W1)" do
    defp user(text), do: %{role: :user, content: text}
    defp assistant(text), do: %{role: :assistant, content: text}

    defp cache_marks(body) do
      sys = Enum.count(body["system"] || [], &Map.has_key?(&1, "cache_control"))
      tools = Enum.count(body["tools"] || [], &Map.has_key?(&1, "cache_control"))

      msgs =
        for m <- body["messages"] || [],
            is_list(m["content"]),
            b <- m["content"],
            Map.has_key?(b, "cache_control"),
            reduce: 0,
            do: (acc -> acc + 1)

      %{system: sys, tools: tools, messages: msgs, total: sys + tools + msgs}
    end

    test "the billing block is byte-stable as the message tape grows" do
      turn1 = Anthropic.build_body("claude-sonnet-4", %{system: "S", messages: [user("hi")]})

      turn5 =
        Anthropic.build_body("claude-sonnet-4", %{
          system: "S",
          messages: [user("hi"), assistant("a1"), user("u2"), assistant("a2"), user("u3")]
        })

      [billing1 | _] = turn1["system"]
      [billing5 | _] = turn5["system"]
      # Same bytes regardless of how many messages have accumulated. A digest
      # seeded on the tape (the old bug) or a random build-hash would differ.
      assert billing1["text"] == billing5["text"]
    end

    test "the billing block does not carry a cache_control breakpoint" do
      body = Anthropic.build_body("claude-sonnet-4", %{system: "S", messages: [user("hi")]})
      [billing | _] = body["system"]
      refute Map.has_key?(billing, "cache_control")
    end

    test "places a breakpoint on the message tail (not only the system block)" do
      body =
        Anthropic.build_body("claude-sonnet-4", %{
          system: "S",
          messages: [user("hi"), assistant("a1"), user("u2")]
        })

      marks = cache_marks(body)
      assert marks.messages >= 1
      assert marks.system >= 1
      assert marks.total <= 4
    end

    test "marks the two most-recent user turns and at most four total" do
      body =
        Anthropic.build_body("claude-sonnet-4", %{
          system: "S",
          tools: [%{"name" => "t", "description" => "d", "input_schema" => %{}}],
          messages: [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")]
        })

      marks = cache_marks(body)
      # tools + system + 2 recent users = the full 4-breakpoint budget.
      assert marks.tools == 1
      assert marks.system == 1
      assert marks.messages == 2
      assert marks.total == 4

      # The two MARKED user turns must be the most-recent pair (u2, u3) \u2014 the
      # rolling tail anchor \u2014 not the oldest pair. An aggregate count alone would
      # pass a regression that marked u1/u2 and lost the newest turn's cache.
      marked_texts =
        for m <- body["messages"],
            is_list(m["content"]),
            b <- m["content"],
            Map.has_key?(b, "cache_control"),
            do: b["text"]

      assert Enum.sort(marked_texts) == ["u2", "u3"]
    end

    test "never exceeds four breakpoints even when the caller pre-marked blocks" do
      premarked =
        for i <- 1..6,
            do: %{"type" => "text", "text" => "b#{i}", "cache_control" => %{"type" => "ephemeral"}}

      body =
        Anthropic.build_body("claude-sonnet-4", %{
          system: premarked,
          messages: [user("u1"), assistant("a1"), user("u2")]
        })

      assert cache_marks(body).total <= 4
    end

    test "a user message given as a string is lifted to a marked text block" do
      body = Anthropic.build_body("claude-sonnet-4", %{system: "S", messages: [user("only")]})

      [msg] = body["messages"]
      assert is_list(msg["content"])
      assert Enum.any?(msg["content"], &Map.has_key?(&1, "cache_control"))
    end

    test "billing cch is stable when the caller pre-marks system blocks differently" do
      # Same system TEXT, different cache_control metadata turn-to-turn. The cch
      # digest must hash text only, so the position-0 billing block is identical.
      # (S1 swarm finding: hashing raw blocks let stripped metadata perturb cch.)
      turn_a =
        Anthropic.build_body("claude-sonnet-4", %{
          system: [%{"type" => "text", "text" => "S"}],
          messages: [user("hi")]
        })

      turn_b =
        Anthropic.build_body("claude-sonnet-4", %{
          system: [%{"type" => "text", "text" => "S", "cache_control" => %{"type" => "ephemeral"}}],
          messages: [user("hi")]
        })

      [billing_a | _] = turn_a["system"]
      [billing_b | _] = turn_b["system"]
      assert billing_a["text"] == billing_b["text"]
    end

    test "an atom-keyed caller cache_control is cleared so the cap cannot be exceeded" do
      # A caller may hand system blocks with atom keys. If a non-last block keeps
      # its :cache_control, the placed tool+system+2-user marks push past 4 and
      # Anthropic hard-rejects. (S1 swarm finding.)
      body =
        Anthropic.build_body("claude-sonnet-4", %{
          system: [
            %{type: "text", text: "S0", cache_control: %{type: "ephemeral"}},
            %{type: "text", text: "S1"}
          ],
          tools: [%{"name" => "t", "description" => "d", "input_schema" => %{}}],
          messages: [user("u1"), assistant("a1"), user("u2")]
        })

      # No surviving atom-keyed breakpoint, and the total is within budget.
      refute Enum.any?(body["system"], &Map.has_key?(&1, :cache_control))
      assert cache_marks(body).total <= 4
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

  # Byte-stability of the cached prefix (PLAN-018 W2). Prefix caching reuses a
  # request only when its leading bytes are identical to a prior request. The
  # tools block leads the cached region, so its serialization must be canonical
  # and order-independent. JSON object-key order is byte-stable turn-over-turn:
  # for a fixed key set the BEAM emits map pairs in a deterministic hash order
  # (not insertion order), and the prefix-cache window is a single VM, so the
  # same logical schema encodes identically each turn. This wave pins TOOL ORDER,
  # which convert_tools does not get for free from a map-derived caller list.
  describe "byte-stable prefix (PLAN-018 W2)" do
    defp tool(name), do: %{"name" => name, "description" => "d", "input_schema" => %{"type" => "object"}}

    test "the outgoing tools array is sorted by name regardless of input order" do
      forward = Anthropic.build_body("claude-sonnet-4", %{tools: [tool("a"), tool("b"), tool("c")]})
      reverse = Anthropic.build_body("claude-sonnet-4", %{tools: [tool("c"), tool("b"), tool("a")]})

      names = fn body -> Enum.map(body["tools"], & &1["name"]) end
      # Same set in either input order -> same wire order.
      assert names.(forward) == names.(reverse)
      assert names.(forward) == ["proxy_a", "proxy_b", "proxy_c"]
    end

    test "the full encoded body is byte-identical across two builds of one request" do
      req = %{
        system: "S",
        tools: [tool("z"), tool("a")],
        messages: [
          %{role: :user, content: "u1"},
          %{role: :assistant, content: "a1"},
          %{role: :user, content: "u2"}
        ]
      }

      b1 = Anthropic.build_body("claude-sonnet-4", req) |> Jason.encode!()
      b2 = Anthropic.build_body("claude-sonnet-4", req) |> Jason.encode!()
      assert b1 == b2
    end

    test "adding a tool preserves the order of the existing tools (append-stable prefix)" do
      before = Anthropic.build_body("claude-sonnet-4", %{tools: [tool("apple"), tool("cherry")]})

      after_add =
        Anthropic.build_body("claude-sonnet-4", %{tools: [tool("apple"), tool("cherry"), tool("banana")]})

      names = fn body -> Enum.map(body["tools"], & &1["name"]) end
      # The new tool slots in by sort position; the relative order of the others
      # is unchanged, so the prefix up to the insertion point stays byte-stable.
      assert names.(before) == ["proxy_apple", "proxy_cherry"]
      assert names.(after_add) == ["proxy_apple", "proxy_banana", "proxy_cherry"]
    end

    test "a tool encodes identically regardless of key insertion order" do
      a = Anthropic.build_body("claude-sonnet-4", %{tools: [tool("x")]}) |> Jason.encode!()

      # Same tool, keys supplied in a different insertion order. The BEAM emits a
      # fixed key set in deterministic hash order, so the bytes match (this is the
      # turn-over-turn stability the prefix cache needs, NOT Jason key-sorting).
      reordered = %{"input_schema" => %{"type" => "object"}, "description" => "d", "name" => "x"}
      b = Anthropic.build_body("claude-sonnet-4", %{tools: [reordered]}) |> Jason.encode!()
      assert a == b
    end

    test "tools whose proxy-prefixed names collide still sort to a stable order" do
      # `find` and `proxy_find` both become `proxy_find`; a name-only sort key
      # would keep their unstable input order. Distinct bodies (different desc)
      # make the collision observable: the whole-block tiebreak must order them
      # identically regardless of input order, so the encoded bytes match.
      a = %{"name" => "find", "description" => "aaa", "input_schema" => %{}}
      b = %{"name" => "proxy_find", "description" => "bbb", "input_schema" => %{}}

      forward = Anthropic.build_body("claude-sonnet-4", %{tools: [a, b]}) |> Jason.encode!()
      reverse = Anthropic.build_body("claude-sonnet-4", %{tools: [b, a]}) |> Jason.encode!()
      assert forward == reverse
    end
  end

end
