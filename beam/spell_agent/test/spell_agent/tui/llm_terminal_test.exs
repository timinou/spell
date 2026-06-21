defmodule SpellAgent.Tui.LlmTerminalTest do
  @moduledoc """
  PLAN-347 Design C + A, end to end: a cassette-backed agent run drives the REAL
  inspector App through a REAL headless terminal, asserted on BOTH channels.

    * Design C (loop-correctness): the Store forest the run produced (structured)
      AND the rendered buffer (visual) — decoupled so a break tells you whether
      the loop or the render regressed.
    * Design A (visual regression): the final buffer is captured as a golden
      transcript and asserted equal on replay.

  The cassette is CAPTURED in `setup_all` (offline, canned SSE, digests recorded
  from the real requests `Session.run` emits) so the fixture stays consistent with
  the live system prompt + tools without a network round-trip. Each test then
  REPLAYS it through the App.

  `async: false`: shared telemetry bus + the process-global cassette seam.
  """

  use ExUnit.Case, async: false

  alias SpellAgent.{Config, LlmCassette, Session}
  alias SpellAgent.LlmTerminal
  alias SpellAgent.Tui.Store

  @cassette "answer_42"
  @model "claude-sonnet-4-5-20250929"
  @prompt "compute the answer"

  # A single turn: a lisp_eval tool call whose program `(return 42)` ENDS the loop
  # immediately (the SubAgent returns the program's value), so the run needs only
  # ONE LLM interaction. The cassette therefore has one digest.
  defp tool_sse do
    """
    event: message_start
    data: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":0}}}

    event: content_block_start
    data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"proxy_lisp_eval","input":{}}}

    event: content_block_delta
    data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"program\\": \\"(return 42)\\"}"}}

    event: message_delta
    data: {"type":"message_delta","usage":{"output_tokens":10}}
    """
  end

  setup_all do
    Config.put("model", @model)

    # CAPTURE the cassette offline: run the bare loop once with the canned SSE so
    # the digest is recorded from the real request `Session.run` emits. The
    # App-driven replays below emit the SAME turn-1 request (fresh session each
    # run = cold start, identical body), so the digest matches.
    {_result, path} =
      LlmCassette.capture(@cassette, [tool_sse()], fn ->
        Session.run(@prompt, llm: LlmCassette.llm(@model), max_turns: 4)
      end)

    on_exit(fn -> File.rm(path) end)
    :ok
  end

  describe "Design C — loop-correctness (structured + visual)" do
    test "the run produces the expected forest AND renders the run" do
      out =
        LlmTerminal.with_terminal(@cassette, fn ->
          LlmTerminal.run_scenario(@cassette, prompt: @prompt)
        end)

      # STRUCTURED: the loop did the right thing — a run span closed ok, with an
      # llm span (the model call) nested under it. (The program `(return 42)`
      # returns a literal without dispatching a `tool/*`, so there is no tool
      # span; the llm span is the observable proof the loop called the model.)
      assert {:ok, 42} = out.result
      assert [run] = Store.run_spans(out.store_forest)
      assert run.kind == :run
      assert run.status == :ok

      kinds = out.store_forest |> Map.values() |> Enum.map(& &1.kind) |> Enum.uniq() |> Enum.sort()
      assert :run in kinds
      assert :llm in kinds

      # VISUAL: the inspector actually rendered the run — the span-tree pane chrome
      # and the run row are on screen (the frame was NOT dropped).
      assert out.buffer =~ "spans"
      refute out.buffer == ""
    end
  end

  describe "Design A — visual regression (golden transcript)" do
    @transcript_dir Path.join([__DIR__, "..", "..", "snapshots", "llm"])

    test "the final screen matches its committed transcript" do
      out =
        LlmTerminal.with_terminal(@cassette, fn ->
          LlmTerminal.run_scenario(@cassette, prompt: @prompt, dimensions: {100, 30})
        end)

      path = Path.join(@transcript_dir, "#{@cassette}.transcript")

      # Mask volatile fields (durations, span ids) so the golden transcript is
      # stable across runs while still pinning the whole structural render.
      normalized = LlmTerminal.normalize_transcript(out.buffer)

      if File.exists?(path) do
        baseline = File.read!(path)

        assert normalized == baseline, """
        LLM transcript mismatch for #{@cassette}.

        If intended, regenerate by deleting #{path} and re-running (it rewrites the
        baseline on first run), then review `git diff`.
        """
      else
        File.mkdir_p!(@transcript_dir)
        File.write!(path, normalized)
        IO.puts("Wrote new LLM transcript baseline: #{path}")
      end
    end
  end
end