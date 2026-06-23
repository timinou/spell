defmodule SpellAgent.Tui.SelfViewDemosTest do
  @moduledoc """
  PLAN-016 W4 — executable acceptance demos for L−1 (PROJ-001): the TUI as the
  agent's own reasoning workspace. Each demo is a runnable proof of one facet of
  "the renderer reads its own output", written to read top-to-bottom as the story
  of the dissolution: OUTPUT vs WORKSPACE collapses because the agent can render a
  view over its own trace and read it back as reasoning input.

  These are DEMOS, not unit tests (those live in self_view_test.exs) — each is a
  small scenario an operator can read to understand what L−1 actually delivers.
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp
  alias SpellAgent.Tui.{SelfView, Store}
  alias SpellAgent.Tui.SelfView.{Budget, Idioms}

  @telemetry_prefix [:ptc_runner, :sub_agent]

  setup do
    :ok = Store.attach(Store)
    Store.reset(Store)
    Budget.reset(self())

    on_exit(fn ->
      Store.reset(Store)
      Budget.reset(self())
    end)

    %{think: SelfView.tools()["view/think"]}
  end

  defp emit(suffix, meta), do: :telemetry.execute(@telemetry_prefix ++ suffix, %{}, meta)

  # ============================================================
  # 1. THE CORE DISSOLUTION — the renderer reads its own output.
  # ============================================================
  # The agent's run-trace is data; a layout over it is data; rendering it to ASCII
  # and reading that back closes the loop output→workspace.
  test "demo 1: an authored view over the live trace renders to readable ASCII", %{think: think} do
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "root"})
    emit([:tool, :start], %{span_id: "t", parent_span_id: "r", tool_name: "edit"})
    emit([:tool, :stop], %{span_id: "t", parent_span_id: "r", tool_name: "edit", result: %{}})

    node =
      quote_node(~S"""
      (tmpl:: {:type "list"
               :block {:type "block" :title " my trace " :borders ["all"]}
               :items [~@(map (fn [s] (get s :label)) (vals data/forest))]})
      """)

    assert %{"buffer" => buffer} = think.(%{"source" => node})
    # The buffer SHOWS the trace the agent itself produced — output read back in.
    assert buffer =~ "my trace"
    assert buffer =~ "edit"
  end

  # ============================================================
  # 2. THE PROJECTIONS EARN THEIR TOKENS — compression, not a dump.
  # ============================================================
  test "demo 2: errors-board compresses a noisy trace to just what broke", %{think: think} do
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "root"})
    # Five ok tools …
    for i <- 1..5 do
      emit([:tool, :start], %{span_id: "ok#{i}", parent_span_id: "r", tool_name: "find"})

      emit([:tool, :stop], %{
        span_id: "ok#{i}",
        parent_span_id: "r",
        tool_name: "find",
        result: %{}
      })
    end

    # … and ONE failure buried among them.
    emit([:tool, :start], %{span_id: "boom", parent_span_id: "r", tool_name: "edit"})

    emit([:tool, :exception], %{
      span_id: "boom",
      parent_span_id: "r",
      tool_name: "edit",
      kind: :error,
      reason: "unbalanced delimiters"
    })

    assert %{"buffer" => buffer} = think.(%{"name" => "errors-board"})
    # The one failure + its reason surface; the five ok finds do NOT \u2014 the board
    # answers "what broke?" without the agent re-reading the whole forest.
    assert buffer =~ "edit"
    assert buffer =~ "unbalanced delimiters"
    refute buffer =~ "find"
  end

  # ============================================================
  # 3. DRAW TO THINK, THEN ACT — the render→observe→act cycle.
  # ============================================================
  # The PROJ-001 A/B acceptance, as a deterministic scenario: a tangled run the
  # agent "failed". It renders the errors-board, READS the buffer, and the buffer
  # surfaces the failing call + its reason — the input a follow-up step keys on.
  test "demo 3: a self-view surfaces the failing call a follow-up step acts on", %{think: think} do
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "root"})
    emit([:tool, :start], %{span_id: "x", parent_span_id: "r", tool_name: "apply_patch"})

    emit([:tool, :exception], %{
      span_id: "x",
      parent_span_id: "r",
      tool_name: "apply_patch",
      kind: :error,
      reason: "hunk did not apply at line 42"
    })

    # OBSERVE: render the board and read the buffer back as reasoning input.
    assert %{"buffer" => buffer} = think.(%{"name" => "errors-board"})
    assert buffer =~ "apply_patch"
    assert buffer =~ "line 42"

    # ACT: a follow-up step keys off the buffer — NOT off the forest. To prove the
    # render→observe→act loop is real (the buffer is genuine reasoning input, not
    # just displayed text), the decision below reads ONLY the rendered ASCII: parse
    # the failing line number out of the buffer the agent "saw", and pick the
    # retry target from it. A projection that merely displayed the text without it
    # being recoverable from the buffer could not pass this.
    retry_line =
      buffer
      |> String.split(~r/\s+/)
      |> Enum.find_value(fn tok ->
        case Integer.parse(tok) do
          {n, ""} -> n
          _ -> nil
        end
      end)

    # The agent's next action (retry the patch at the failing site) is decided
    # entirely from what the self-view surfaced.
    assert retry_line == 42
  end

  # ============================================================
  # 4. THE LOOP CANNOT SPIN — budget + fixpoint keep it honest.
  # ============================================================
  test "demo 4: re-rendering an unchanged view is flagged as a fixpoint", %{think: think} do
    # An empty, stable trace: the same view twice is identical.
    assert %{"buffer" => _} = think.(%{"name" => "trace-summary"})
    assert %{"note" => note} = think.(%{"name" => "trace-summary"})
    # The agent is told the view is unchanged — re-rendering teaches it nothing.
    assert note =~ "fixpoint"
  end

  test "demo 5: a runaway render loop is cut deterministically at the budget", %{think: think} do
    # Simulate a loop that renders past the per-mission cap (charge directly to the
    # cap, then the next render through the tool must be the hard cut).
    for i <- 1..Budget.max_renders(), do: Budget.charge("frame-#{i}")

    result = think.(%{"name" => "trace-summary"})
    assert %{"err" => msg} = result
    assert msg =~ "budget"
    # The cut returns NO buffer — the loop is severed, not merely annotated.
    refute Map.has_key?(result, "buffer")
  end

  # ============================================================
  # 5. READ-ONLY BY CONSTRUCTION — looking never acts.
  # ============================================================
  test "demo 6: drawing a self-view never mutates the trace it draws", %{think: think} do
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "root"})
    emit([:tool, :start], %{span_id: "t", parent_span_id: "r", tool_name: "find"})
    emit([:tool, :stop], %{span_id: "t", parent_span_id: "r", tool_name: "find", result: %{}})

    before = Store.spans(Store)
    assert %{"buffer" => _} = think.(%{"name" => "tool-calls"})
    # The forest is byte-identical after the render: a self-view only ever LOOKS.
    assert Store.spans(Store) == before
  end

  # ============================================================
  # 6. THE VOCABULARY IS DISCOVERABLE — the idiom set is stable.
  # ============================================================
  test "demo 7: the built-in trace idioms are the documented set", %{think: think} do
    assert Idioms.names() == ["errors-board", "tool-calls", "trace-summary"]
    # Each renders without error over an (empty) live trace — the prelude promises
    # exactly these names work.
    for name <- Idioms.names() do
      assert %{"buffer" => _} = think.(%{"name" => name})
    end
  end

  defp quote_node(src) do
    {:ok, step} = Lisp.run(src)
    step.return
  end
end
