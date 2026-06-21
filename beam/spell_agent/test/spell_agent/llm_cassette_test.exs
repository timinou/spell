defmodule SpellAgent.LlmCassetteTest do
  @moduledoc """
  Proves the LLM cassette round-trip (FEAT-006): a run CAPTURED offline (canned
  SSE, digests recorded from the real requests the adapter emits) REPLAYS to the
  identical result, driving the real `Anthropic.parse_response/1` SSE folder with
  zero network.

  `async: false`: the cassette installs a process-global Req.Test stub + an app-env
  seam, so parallel tests would cross-talk.
  """

  use ExUnit.Case, async: false

  alias SpellAgent.{Anthropic, LlmCassette}

  # A minimal one-shot text response in Anthropic's SSE shape.
  defp text_sse(text) do
    """
    event: message_start
    data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}

    event: content_block_start
    data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

    event: content_block_delta
    data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"#{text}"}}

    event: message_delta
    data: {"type":"message_delta","usage":{"output_tokens":3}}
    """
  end

  setup do
    # Each test uses a uniquely named cassette under a tmp name so capture writes
    # don't collide; clean it up after.
    name = "test_#{System.unique_integer([:positive])}"
    on_exit(fn -> File.rm(LlmCassette.path(name)) end)
    %{name: name}
  end

  test "capture then replay yields identical adapter results", %{name: name} do
    request = %{system: "Be terse.", messages: [%{"role" => "user", "content" => "ping"}]}

    # CAPTURE: serve canned SSE, record the digest of the real request emitted.
    {captured, cassette_path} =
      LlmCassette.capture(name, [text_sse("pong")], fn ->
        Anthropic.call_with_token("claude-sonnet-4-5-20250929", request, "fake-token")
      end)

    assert {:ok, %{content: "pong"}} = captured
    assert File.exists?(cassette_path)

    # REPLAY: same request, served from the cassette by digest — no canned SSE in
    # scope, so this can ONLY come from the recorded fixture.
    replayed =
      LlmCassette.with_cassette(name, fn ->
        Anthropic.call_with_token("claude-sonnet-4-5-20250929", request, "fake-token")
      end)

    assert replayed == captured
    assert {:ok, %{content: "pong", tokens: %{input: 7, output: 3}}} = replayed
  end

  test "replay raises on an unknown request digest (offline contract)", %{name: name} do
    # Capture for request A...
    LlmCassette.capture(name, [text_sse("a")], fn ->
      Anthropic.call_with_token("claude-sonnet-4-5-20250929", %{messages: [%{"role" => "user", "content" => "A"}]}, "tok")
    end)

    # ...then replay a DIFFERENT request B → no matching digest → loud raise (never
    # a silent fallthrough to the network).
    assert_raise RuntimeError, ~r/no interaction for request digest/, fn ->
      LlmCassette.with_cassette(name, fn ->
        Anthropic.call_with_token("claude-sonnet-4-5-20250929", %{messages: [%{"role" => "user", "content" => "B"}]}, "tok")
      end)
    end
  end

  test "the cassette file carries no secret", %{name: name} do
    LlmCassette.capture(name, [text_sse("ok")], fn ->
      Anthropic.call_with_token("claude-sonnet-4-5-20250929", %{messages: [%{"role" => "user", "content" => "x"}]}, "super-secret-token")
    end)

    # The bearer token was in the REQUEST; the cassette stores only response SSE +
    # the request digest, so the secret never lands on disk.
    assert :ok = LlmCassette.assert_no_secrets(name)
  end

  test "the digest is stable across the volatile billing header" do
    # Two requests identical except for the billing-header system block (cch/rand)
    # must hash equal, so a cassette recorded once keeps matching across runs.
    base = %{
      "model" => "claude-sonnet-4-5-20250929",
      "messages" => [%{"role" => "user", "content" => "ping"}],
      "system" => [
        %{"type" => "text", "text" => "x-anthropic-billing-header: cc_version=1.aaa; cch=11111;"},
        %{"type" => "text", "text" => "You are a Claude agent, built on Anthropic's Claude Agent SDK."},
        %{"type" => "text", "text" => "Be terse."}
      ]
    }

    mutated =
      put_in(base, ["system", Access.at(0), "text"], "x-anthropic-billing-header: cc_version=9.zzz; cch=99999;")

    assert LlmCassette.digest(base) == LlmCassette.digest(mutated)
  end
end