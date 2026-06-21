defmodule SpellAgent.Tui.LoopIntegrationTest do
  @moduledoc """
  The spike's load-bearing test (PLAN-345): a FAKE llm drives the REAL
  `PtcRunner.SubAgent` loop in `:tool_call` mode, emitting genuine telemetry that
  `SpellAgent.Tui.Store` captures into a live span forest — and the `SpanTree`
  pane projects it. No network, no NIF, no terminal.

  This proves the whole spine end to end: Session.run (injected llm) → real loop
  → telemetry → Store forest → pane projection.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.{Config, Session, ToolRegistry}
  alias SpellAgent.Tui.{Projection, Store}
  alias SpellAgent.Tui.Panes.SpanTree

  setup do
    for e <- ToolRegistry.all(), do: ToolRegistry.remove(e.name)
    Config.put("model", "fake-model")

    {:ok, store} = Store.start_link(name: nil)
    :ok = Store.attach(store)
    %{store: store}
  end

  # A scripted llm: returns the next canned response per call. In :tool_call mode
  # the loop expects either a `lisp_eval` tool call (run a program) or direct
  # content (final answer).
  # A scripted llm. Once the script is exhausted it repeats `on_exhaust` so an
  # extra loop turn (e.g. a must-return nudge) still drives a deterministic
  # response rather than a stray final answer.
  defp scripted_llm(steps, on_exhaust \\ %{content: "done"}) do
    {:ok, agent} = Agent.start_link(fn -> steps end)

    fn _request ->
      resp =
        Agent.get_and_update(agent, fn
          [next | rest] -> {next, rest}
          [] -> {on_exhaust, []}
        end)

      {:ok, resp}
    end
  end

  defp lisp_eval(program) do
    %{
      tool_calls: [
        %{
          id: "call_#{System.unique_integer([:positive])}",
          name: "lisp_eval",
          args: %{"program" => program}
        }
      ]
    }
  end

  test "a real run with a tool call is captured as a span forest", %{store: store} do
    # Turn 1: run a program that calls a tool (list-tools) and returns.
    llm =
      scripted_llm([
        lisp_eval(~s|(return (count (tool/list-tools {})))|)
      ])

    assert {:ok, result} = Session.run("how many tools?", llm: llm, max_turns: 4)
    assert is_integer(result)

    spans = Store.spans(store)

    # A root run span exists and closed ok.
    assert [run] = Store.run_spans(spans)
    assert run.kind == :run
    assert run.status == :ok

    # The run captured at least one turn (folded from [:turn, …] emits).
    assert run.turns != []

    # At least one llm span nested under the run (the loop called our fake llm).
    assert Enum.any?(Store.children(spans, run.id), &(&1.kind == :llm))

    # The SpanTree pane projects the forest into depth-ordered rows.
    %{rows: rows} = SpanTree.project(spans, %{})
    assert Enum.any?(rows, &((&1.span && &1.span.kind == :run) and &1.depth == 0))
    # The run's turn shows up indented beneath it.
    assert Enum.any?(rows, &(&1.turn != nil and &1.depth == 1))
  end

  test "the homoiconic path is visible: define-tool runs as a tool span in the forest", %{
    store: store
  } do
    # One program authors a new tool (the homoiconic meta-tool) and inspects the
    # inventory. Both are real `(tool/…)` calls ⇒ tool spans the Store captures.
    # (NB: a tool defined mid-program is registered but not callable in the SAME
    # program — the agent's tools map is snapshot at run start — so we assert on
    # the observable define-tool + list-tools spans, not same-program dispatch.)
    program =
      ~s|(do (tool/define-tool {:name "triple" :params [:n] :source "(* 3 data/n)"}) (return (count (tool/list-tools {}))))|

    llm = scripted_llm([lisp_eval(program)])

    assert {:ok, result} = Session.run("author a tool", llm: llm, max_turns: 6)
    assert is_integer(result)

    # The agent-authored tool is now durably in the registry.
    assert "triple" in Enum.map(ToolRegistry.all(), & &1.name)

    spans = Store.spans(store)
    tool_names = spans |> Store.tool_spans() |> Enum.map(& &1.meta[:tool_name])

    # The meta-tool (define-tool) and list-tools both ran as observable tool
    # spans — the homoiconic authoring step is visible inside the run.
    assert "define-tool" in tool_names
    assert "list-tools" in tool_names

    # Projection + dirty-filter: only panes whose events fired re-project.
    panes = [%{name: :tree, module: SpanTree, assigns: %{}}]
    vms = Projection.reconcile(spans, panes, [[:tool, :stop]], %{})
    assert %{tree: %{rows: rows}} = vms
    assert Enum.any?(rows, fn r -> r.span && r.span.kind == :tool end)
  end

  test "FREEFORM: the agent reshapes the live TUI through the real loop (PLAN-009)", %{
    store: _store
  } do
    # Seed the canonical layout tree so layout/set has a slot to shadow.
    alias SpellAgent.Tui.{DefaultLayout, LayoutRegistry, Ui}

    default =
      DefaultLayout.tree(Ui.new(panes: [:tree, :detail], focus: :tree), ["tree", "detail"])

    case Process.whereis(LayoutRegistry) do
      nil -> start_supervised!({LayoutRegistry, default: default})
      _ -> LayoutRegistry.seed_default(default)
    end

    # A program the agent emits after reading the freeform prelude: build a widget
    # with view/ and install it at the status slot via layout/set. This exercises
    # the WHOLE path — prelude advertises it, the loop's tools map carries the
    # view/+layout/ namespaces, the program runs, the registry holds the shadow.
    program =
      ~s|(do (layout/set {:slot "status" :source (view/paragraph {:text "RESHAPED BY THE AGENT"})}) (return "ok"))|

    llm = scripted_llm([lisp_eval(program)])

    assert {:ok, _result} = Session.run("reshape the header", llm: llm, max_turns: 6)

    # The live tree now carries the agent's shadow at the status slot.
    assert {:ok, shown} = LayoutRegistry.show("status")
    assert shown["text"] == "RESHAPED BY THE AGENT"
  end
end
