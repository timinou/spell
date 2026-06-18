defmodule SpellAgent.Tui.StoreTest do
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.Store
  alias SpellAgent.Tui.Store.Span

  @prefix [:ptc_runner, :sub_agent]

  setup do
    {:ok, pid} = Store.start_link(name: nil)
    :ok = Store.attach(pid)
    %{store: pid}
  end

  # Emit a real telemetry event the same way PtcRunner.SubAgent.Telemetry does:
  # span_id / parent_span_id live in metadata.
  defp emit(suffix, meta, meas \\ %{}) do
    :telemetry.execute(@prefix ++ suffix, meas, meta)
  end

  # The store handles events via cast; give the mailbox a beat to drain.
  defp sync(pid), do: Store.spans(pid)

  test "a flat run with a turn, an llm span, and a tool span builds a forest", %{store: pid} do
    emit([:run, :start], %{span_id: "run1", parent_span_id: nil, agent_name: "root"})
    emit([:turn, :start], %{span_id: "run1", turn: 1, program: "(+ 1 2)"})
    emit([:llm, :start], %{span_id: "llm1", parent_span_id: "run1", model: "sonnet"})
    emit([:llm, :stop], %{span_id: "llm1", parent_span_id: "run1", response: "ok"})
    emit([:tool, :start], %{span_id: "tool1", parent_span_id: "run1", tool_name: "find"})
    emit([:tool, :stop], %{span_id: "tool1", parent_span_id: "run1", tool_name: "find", result: %{}})
    emit([:turn, :stop], %{span_id: "run1", turn: 1, program: "(+ 1 2)", result_preview: "3"})
    emit([:run, :stop], %{span_id: "run1", status: :ok, return: 3})

    spans = sync(pid)

    assert [%Span{kind: :run, id: "run1", status: :ok} = run] = Store.run_spans(spans)
    # llm + tool are children of the run, in start order.
    assert [%Span{kind: :llm, id: "llm1"}, %Span{kind: :tool, id: "tool1"}] =
             Store.children(spans, "run1")

    # turn was folded onto the run span (not a node), and closed :ok.
    assert [%{number: 1, program: "(+ 1 2)", result_preview: "3", status: :ok}] = run.turns

    assert Store.roots(pid) == ["run1"]
  end

  test "a tool whose impl is a sub-agent nests a child run (inside the insides)", %{store: pid} do
    # Parent run -> tool -> nested run -> nested llm.
    emit([:run, :start], %{span_id: "run1", parent_span_id: nil, agent_name: "root"})
    emit([:tool, :start], %{span_id: "tool1", parent_span_id: "run1", tool_name: "sub_agent"})
    emit([:run, :start], %{span_id: "run2", parent_span_id: "tool1", agent_name: "child"})
    emit([:llm, :start], %{span_id: "llm2", parent_span_id: "run2", model: "haiku"})
    emit([:llm, :stop], %{span_id: "llm2", parent_span_id: "run2", response: "done"})
    emit([:run, :stop], %{span_id: "run2", status: :ok, return: 42})
    emit([:tool, :stop], %{span_id: "tool1", parent_span_id: "run1", tool_name: "sub_agent"})
    emit([:run, :stop], %{span_id: "run1", status: :ok})

    spans = sync(pid)

    assert Store.roots(pid) == ["run1"]
    assert [%Span{id: "tool1"}] = Store.children(spans, "run1")
    assert [%Span{id: "run2", kind: :run}] = Store.children(spans, "tool1")
    assert [%Span{id: "llm2", kind: :llm}] = Store.children(spans, "run2")

    # subtree flattens the whole interior depth-first, root first.
    assert ["run1", "tool1", "run2", "llm2"] = Enum.map(Store.subtree(spans, "run1"), & &1.id)
  end

  test "an exception event closes the span as :error", %{store: pid} do
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "x"})
    emit([:tool, :start], %{span_id: "t", parent_span_id: "r", tool_name: "boom"})
    emit([:tool, :exception], %{span_id: "t", parent_span_id: "r", tool_name: "boom"})

    spans = sync(pid)
    assert %Span{id: "t", status: :error} = spans["t"]
  end

  test "subscribers receive {:store_updated, suffix} per event", %{store: pid} do
    :ok = Store.subscribe(pid)
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "x"})
    assert_receive {:store_updated, [:run, :start]}
    emit([:run, :stop], %{span_id: "r", status: :ok})
    assert_receive {:store_updated, [:run, :stop]}
  end

  test "llm label shows tokens, never the callback fn (regression)", %{store: pid} do
    a_fn = fn _ -> :ok end
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "root"})
    emit([:llm, :start], %{span_id: "l", parent_span_id: "r", model: a_fn})
    # tokens arrive in MEASUREMENTS (2nd arg), not metadata.
    emit([:llm, :stop], %{span_id: "l", parent_span_id: "r", model: a_fn}, %{
      tokens: 400,
      input_tokens: 312,
      output_tokens: 88
    })

    spans = sync(pid)
    llm = spans["l"]

    refute llm.label =~ "Function", "the callback fn must never leak into the label"
    assert llm.label =~ "312→88 tok"
    assert llm.tokens == %{tokens: 400, input: 312, output: 88}
  end

  test "turn start program survives the stop (fields merge, no clobber)", %{store: pid} do
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "root"})
    # start sets the program; stop carries the result but NO program.
    emit([:turn, :start], %{span_id: "r", turn: 1, program: "(tool/list-tools {})"})
    emit([:turn, :stop], %{span_id: "r", turn: 1, result_preview: "3"})

    spans = sync(pid)
    [turn] = spans["r"].turns
    assert turn.program == "(tool/list-tools {})", "program from :start must not be clobbered by :stop"
    assert turn.result_preview == "3"
    assert turn.status == :ok
  end

  test "tool label shows the result summary", %{store: pid} do
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "root"})
    emit([:tool, :start], %{span_id: "t", parent_span_id: "r", tool_name: "list-tools", args: %{}})
    emit([:tool, :stop], %{span_id: "t", parent_span_id: "r", tool_name: "list-tools", result: "4"})

    spans = sync(pid)
    assert spans["t"].label =~ "list-tools"
    assert spans["t"].label =~ "→ 4"
  end

  test "reset clears the forest but keeps subscriptions", %{store: pid} do
    :ok = Store.subscribe(pid)
    emit([:run, :start], %{span_id: "r", parent_span_id: nil, agent_name: "x"})
    assert map_size(sync(pid)) == 1
    :ok = Store.reset(pid)
    assert sync(pid) == %{}
    assert Store.roots(pid) == []
    emit([:run, :start], %{span_id: "r2", parent_span_id: nil, agent_name: "y"})
    assert_receive {:store_updated, [:run, :start]}
  end
end
