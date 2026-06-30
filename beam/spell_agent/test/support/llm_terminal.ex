defmodule SpellAgent.LlmTerminal do
  @moduledoc """
  The single entry point both PLAN-347 LLM terminal suites build on (FEAT-007):
  drive the REAL inspector `App` through a REAL headless terminal, fed by a REAL
  agent loop replaying an LLM cassette — no network.

  It ties together the three pieces shipped earlier in PLAN-347:

    * `SpellAgent.LlmCassette` (FEAT-006) — offline LLM responses.
    * `ExRatatui.Runtime.buffer/1` (ex_ratatui PATCH-2) — read the rendered screen.
    * the total render contract (BUG-009/010) — a malformed widget degrades to a
      gap, so a real run never drops a frame mid-flight.

  ## `run_scenario/2`

  Boots `App` in `test_mode`, submits `prompt` (which the App runs as a mission
  Task via `Session.run`, driven by the cassette llm), waits for QUIESCENCE (the
  mission Task finished AND the final render settled), and returns:

      %{store_forest: %{span_id => Span.t()}, buffer: String.t(), result: term()}

  `store_forest` powers Design C's STRUCTURED assertions (the span tree the run
  produced); `buffer` powers Design C's VISUAL assertion and Design A's golden
  transcript. `result` is the mission's `{:ok, _} | {:error, _}`.

  ## Quiescence, not frame-counting

  We snapshot at quiescence (after the run Task exits), NOT on every render tick,
  so a benign extra frame can't shift a baseline. `await_quiescence/2` polls the
  App's `running?` flag (set false when the mission Task result arrives) and then
  reads the buffer once.
  """

  alias ExRatatui.Runtime
  alias SpellAgent.{Config, LlmCassette, Session}
  alias SpellAgent.Tui.{App, Store}

  @default_model "claude-sonnet-4-5-20250929"

  @doc """
  Run one cassette-backed scenario end to end and return
  `%{store_forest, buffer, result}`.

  `opts`:
    * `:dimensions` — `{w, h}` for the test terminal (default `{100, 30}`).
    * `:model` — model id (default a Sonnet id); also set as the live Config model.
    * `:max_turns` — loop bound (default 6).
    * `:timeout` — quiescence wait in ms (default 5000).
  """
  @spec run_scenario(String.t(), keyword()) :: %{store_forest: map(), buffer: String.t(), result: term()}
  def run_scenario(_cassette_name, opts \\ []) do
    {w, h} = Keyword.get(opts, :dimensions, {100, 30})
    model = Keyword.get(opts, :model, @default_model)
    max_turns = Keyword.get(opts, :max_turns, 6)
    timeout = Keyword.get(opts, :timeout, 5000)
    prompt = Keyword.get(opts, :prompt, "go")

    Config.put("model", model)
    {:ok, store} = Store.start_link(name: nil)
    :ok = Store.attach(store)

    test_pid = self()

    # The llm driving the loop: a SCRIPTED callback when `:llm` is given (network-
    # free, no cassette — the mesh tests' dispatch_llm pattern, for a deterministic
    # tool-driven scenario like a codemod), else the recorded cassette llm. Both
    # are pure `(request -> {:ok, resp})` callbacks the SubAgent loop calls.
    llm = Keyword.get(opts, :llm) || LlmCassette.llm(model)

    # The App submits the prompt as a Task running this fn; it executes inside the
    # cassette scope (set up by the caller via with_terminal/3) because the seam is
    # app-env global + Req.Test shared mode.
    # Session.run does NOT take a store: the run emits telemetry on the global bus
    # and the App's attached Store captures it. We just drive the loop with the
    # llm and report the result back for the quiescence wait.
    on_submit = fn p ->
      result = Session.run(p, llm: llm, max_turns: max_turns)
      send(test_pid, {:scenario_result, result})
      result
    end

    {:ok, app} =
      App.start_link(name: nil, store: store, test_mode: {w, h}, on_submit: on_submit)

    # Submit the prompt the way a user would. Launch is PROMPT focus + NORMAL
    # mode: Enter enters INSERT, type the prompt, Enter submits (the App's W5
    # flow, mirrored from app_test.exs).
    :ok = Runtime.inject_event(app, key("enter"))
    type_prompt(app, prompt)
    :ok = Runtime.inject_event(app, key("enter"))

    result = await_result(timeout)
    :ok = await_quiescence(app, timeout)

    forest = Store.spans(store)
    {:ok, buffer} = Runtime.buffer(app)

    # start_link LINKS these to the caller; unlink before killing so the exit
    # signal can't take the test process down with it.
    teardown(app)
    teardown(store)

    %{store_forest: forest, buffer: buffer, result: result}
  end

  @doc """
  Open a cassette scope for the duration of `fun`. Thin wrapper over
  `LlmCassette.with_cassette/3` so a scenario reads top-to-bottom:

      LlmTerminal.with_terminal("two_turn", fn ->
        LlmTerminal.run_scenario("two_turn", prompt: "...")
      end)
  """
  @spec with_terminal(String.t(), keyword(), (-> result)) :: result when result: term()
  def with_terminal(cassette_name, opts \\ [], fun) do
    LlmCassette.with_cassette(cassette_name, opts, fun)
  end

  @doc """
  Block until the App is quiescent (mission Task finished → `running?` false),
  then return `:ok`. Polls because the mission runs off the App process; the final
  render has already happened by the time `running?` flips.
  """
  @spec await_quiescence(GenServer.server(), non_neg_integer()) :: :ok | {:error, :timeout}
  def await_quiescence(app, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    poll_quiescence(app, deadline)
  end

  defp poll_quiescence(app, deadline) do
    running? = :sys.get_state(app).user_state.running?

    cond do
      not running? -> :ok
      System.monotonic_time(:millisecond) > deadline -> {:error, :timeout}
      true ->
        Process.sleep(10)
        poll_quiescence(app, deadline)
    end
  end

  # Wait for the mission result message the on_submit fn sends.
  defp await_result(timeout) do
    receive do
      {:scenario_result, result} -> result
    after
      timeout -> {:error, :timeout}
    end
  end

  # Type each char into the composer (the App is already in INSERT mode by the
  # time this runs).
  defp type_prompt(app, prompt) do
    for <<ch::utf8 <- prompt>> do
      :ok = Runtime.inject_event(app, key(<<ch::utf8>>))
    end
  end

  @doc """
  Mask the non-deterministic fields of a rendered buffer so it is stable enough to
  use as a golden transcript (Design A). Durations (`324ms`, `1.2s`) and span ids
  (`id: a2325a72`, `run a2325a72`) vary every run; everything structural — the
  tree shape, glyphs, titles, turn text, the final answer — is preserved.

  Apply to BOTH the freshly-rendered buffer and the committed baseline before
  comparing, so the assertion is on the STABLE content only.
  """
  @spec normalize_transcript(String.t()) :: String.t()
  def normalize_transcript(buffer) do
    buffer
    # Durations: 324ms / 1ms / 1.2s -> <dur>
    |> String.replace(~r/\d+(\.\d+)?(ms|s)\b/, "<dur>")
    # Explicit id fields: "id: a2325a72" -> "id: <id>"
    |> String.replace(~r/\bid: [a-f0-9]{6,}/, "id: <id>")
    # Bare hex span ids embedded in titles/labels (>=8 hex) -> <id>
    |> String.replace(~r/\b[a-f0-9]{8,}\b/, "<id>")
  end

  defp key(code), do: %ExRatatui.Event.Key{code: code, kind: "press", modifiers: []}

  defp teardown(pid) do
    if Process.alive?(pid) do
      Process.unlink(pid)
      Process.exit(pid, :shutdown)
    end
  end
end