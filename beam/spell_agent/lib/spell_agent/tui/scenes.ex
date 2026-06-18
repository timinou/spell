defmodule SpellAgent.Tui.Scenes do
  @moduledoc """
  Curated fixture forests for the screen gallery (PLAN-347).

  Each scene is a `%{name, about, forest}` map where `forest` is a
  `%{span_id => Span.t()}` map shaped exactly like the live `Store` builds — so
  rendering it through `SpanTree.project/2` exercises the real projection path.

  These double as golden inputs: the gallery shows them to a human, and a
  visual-diff test can render each `forest` headless and assert on the output.
  Keep them small, deterministic (fixed `t0/t1` so durations are stable), and
  each one focused on ONE shape the pane must handle correctly.
  """

  alias SpellAgent.Tui.Store.Span

  @doc "Every gallery scene, in display order."
  @spec all() :: [%{name: String.t(), about: String.t(), forest: map()}]
  def all do
    [
      empty(),
      single_run(),
      run_with_turns(),
      nested_subagent(),
      error_path(),
      wide_fanout(),
      deep_chain()
    ]
  end

  # An empty forest — the "idle, nothing run yet" state. The pane must render a
  # zero-row list without crashing (selected: nil).
  defp empty do
    %{name: "empty", about: "no spans yet — the idle inspector", forest: %{}}
  end

  # A single completed run with no children: the simplest non-empty tree.
  defp single_run do
    forest = %{
      "run1" => %Span{
        id: "run1",
        parent_id: nil,
        kind: :run,
        status: :ok,
        label: "answer: 2+2",
        t0: 0,
        t1: ms(120),
        turns: []
      }
    }

    %{name: "single run", about: "one finished run, no children", forest: forest}
  end

  # A run carrying inline turns (folded onto the run, not child nodes) plus one
  # tool. Exercises the turn-row rendering under a run.
  defp run_with_turns do
    forest = %{
      "run1" => %Span{
        id: "run1",
        parent_id: nil,
        kind: :run,
        status: :ok,
        label: "refactor auth",
        t0: 0,
        t1: ms(900),
        children: ["tool1"],
        turns: [
          %{number: 1, program: "(tool/find {:target \"auth\"})", result_preview: "12 hits", response: nil, status: :ok},
          %{number: 2, program: "(tool/edit {...})", result_preview: "ok", response: nil, status: :ok}
        ]
      },
      "tool1" => %Span{
        id: "tool1",
        parent_id: "run1",
        kind: :tool,
        status: :ok,
        label: "tool find",
        t0: ms(50),
        t1: ms(110)
      }
    }

    %{name: "run + turns", about: "turns folded inline under a run, with a tool", forest: forest}
  end

  # The signature shape: a tool whose implementation is itself a sub-agent, so a
  # CHILD run hangs under the tool — "inside the insides".
  defp nested_subagent do
    forest = %{
      "run1" => %Span{
        id: "run1",
        parent_id: nil,
        kind: :run,
        status: :ok,
        label: "root mission",
        t0: 0,
        t1: ms(1500),
        children: ["tool1"],
        turns: [%{number: 1, program: "(tool/sub-agent {:task \"summarize\"})", result_preview: "done", response: nil, status: :ok}]
      },
      "tool1" => %Span{
        id: "tool1",
        parent_id: "run1",
        kind: :tool,
        status: :ok,
        label: "tool sub-agent",
        t0: ms(60),
        t1: ms(1400),
        children: ["run2"]
      },
      "run2" => %Span{
        id: "run2",
        parent_id: "tool1",
        kind: :run,
        status: :ok,
        label: "nested run",
        t0: ms(80),
        t1: ms(1380),
        children: ["llm2"],
        turns: []
      },
      "llm2" => %Span{
        id: "llm2",
        parent_id: "run2",
        kind: :llm,
        status: :ok,
        label: "llm haiku",
        t0: ms(100),
        t1: ms(1300)
      }
    }

    %{name: "nested sub-agent", about: "a tool whose body is itself a run (depth 3)", forest: forest}
  end

  # A failing path: a tool errors and its parent run is marked error. Exercises
  # the red status color + ✗ glyph rendering.
  defp error_path do
    forest = %{
      "run1" => %Span{
        id: "run1",
        parent_id: nil,
        kind: :run,
        status: :error,
        label: "broken mission",
        t0: 0,
        t1: ms(300),
        children: ["tool1"],
        turns: [%{number: 1, program: "(tool/find {:target \"???\"})", result_preview: "raised", response: nil, status: :error}]
      },
      "tool1" => %Span{
        id: "tool1",
        parent_id: "run1",
        kind: :tool,
        status: :error,
        label: "tool find",
        t0: ms(40),
        t1: ms(280)
      }
    }

    %{name: "error path", about: "a tool + run in the error state (✗, red)", forest: forest}
  end

  # Many sibling tools under one run — exercises a tall, flat list and scrolling.
  defp wide_fanout do
    tools =
      for i <- 1..8, into: %{} do
        id = "tool#{i}"

        {id,
         %Span{
           id: id,
           parent_id: "run1",
           kind: :tool,
           status: if(rem(i, 4) == 0, do: :error, else: :ok),
           label: "tool step #{i}",
           t0: ms(i * 10),
           t1: ms(i * 10 + 30)
         }}
      end

    run = %Span{
      id: "run1",
      parent_id: nil,
      kind: :run,
      status: :ok,
      label: "fan-out mission",
      t0: 0,
      t1: ms(400),
      children: Enum.map(1..8, &"tool#{&1}"),
      turns: []
    }

    %{name: "wide fan-out", about: "8 sibling tools under one run (one fails)", forest: Map.put(tools, "run1", run)}
  end

  # A deep linear chain run -> tool -> run -> tool ... to stress indentation and
  # the collapse/expand path at depth.
  defp deep_chain do
    forest =
      Enum.reduce(0..5, %{}, fn d, acc ->
        id = "n#{d}"
        parent = if d == 0, do: nil, else: "n#{d - 1}"
        kind = if rem(d, 2) == 0, do: :run, else: :tool

        span = %Span{
          id: id,
          parent_id: parent,
          kind: kind,
          status: :ok,
          label: "#{kind} level #{d}",
          t0: ms(d * 20),
          t1: ms(d * 20 + 100),
          children: if(d < 5, do: ["n#{d + 1}"], else: []),
          turns: []
        }

        Map.put(acc, id, span)
      end)

    %{name: "deep chain", about: "6-level run/tool alternation (indent + collapse)", forest: forest}
  end

  # Fixed durations: convert a millisecond count into native time units so
  # `Span.duration_ms/1` renders a stable, deterministic "Nms" in every scene.
  defp ms(n), do: System.convert_time_unit(n, :millisecond, :native)
end