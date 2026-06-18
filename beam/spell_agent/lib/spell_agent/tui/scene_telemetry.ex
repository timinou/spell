defmodule SpellAgent.Tui.SceneTelemetry do
  @moduledoc """
  Replays a gallery scene's fixture forest as the REAL telemetry event stream the
  live agent emits (PLAN-347), so a scene can drive an actual `SpellAgent.Tui.Store`
  exactly as a mission would — no network, no agent loop.

  This is what lets the integration test prove two things at once:

    1. the fixture forests in `SpellAgent.Tui.Scenes` are FAITHFUL — they have the
       same shape the Store builds from genuine `[:ptc_runner, :sub_agent, …]`
       telemetry, not a hand-rolled approximation, and
    2. the Store's event handling (parent/child linking, status, turn folding) is
       correct end to end.

  `emit/2` walks the forest parents-before-children (so a child's `:start` always
  finds its parent already open), emitting `<kind> :start` then, for finished
  spans, `<kind> :stop` with the fixture's status. Run-span turns are emitted as
  `:turn` events tagged with the run's id, exactly as PtcRunner does.
  """

  alias SpellAgent.Tui.Store.Span

  @prefix [:ptc_runner, :sub_agent]

  @doc """
  Emit `scene.forest` (or a raw forest map) as telemetry to whatever has attached
  a handler (e.g. a `Store` that called `attach/1`). Returns `:ok`.

  Emission order is a topological walk from the roots, so `parent_span_id` always
  resolves. A span with a non-nil `t1` is treated as finished and gets a matching
  `:stop`; a span still "running" (`t1 == nil`) gets only its `:start`.
  """
  @spec emit(map(), keyword()) :: :ok
  def emit(%{forest: forest}, opts), do: emit(forest, opts)

  def emit(forest, _opts) when is_map(forest) do
    roots =
      forest
      |> Map.values()
      |> Enum.filter(&(&1.parent_id == nil))
      |> Enum.sort_by(& &1.id)

    Enum.each(roots, &emit_span(forest, &1))
    :ok
  end

  # Emit one span's :start, then its turns (runs only), recurse into children in a
  # stable id order, and finally the span's :stop if it has finished.
  defp emit_span(forest, %Span{} = span) do
    exec(@prefix ++ [span.kind, :start], %{}, %{
      span_id: span.id,
      parent_span_id: span.parent_id,
      agent_name: span.label,
      tool_name: span.label
    })

    for turn <- span.turns, do: emit_turn(span.id, turn)

    forest
    |> children(span.id)
    |> Enum.each(&emit_span(forest, &1))

    if finished?(span) do
      exec(@prefix ++ [span.kind, :stop], %{}, %{span_id: span.id, status: span.status})
    end
  end

  # Map a fixture turn's fields onto the REAL telemetry meta keys the Store reads:
  # the turn number is `:turn` (not `:number`), and the run is tagged via
  # `:span_id`. Using the wrong keys would silently fold every turn into one
  # `number: nil` entry — exactly the bug this mapping prevents.
  defp emit_turn(run_id, turn) do
    meta = %{
      span_id: run_id,
      turn: turn[:number],
      program: turn[:program],
      result_preview: turn[:result_preview],
      response: turn[:response]
    }

    exec(@prefix ++ [:turn, :stop], %{}, meta)
  end

  defp children(forest, parent_id) do
    forest
    |> Map.values()
    |> Enum.filter(&(&1.parent_id == parent_id))
    |> Enum.sort_by(& &1.id)
  end

  # A fixture span is "finished" when it carries a stop time. Running spans
  # (t1 == nil) are left open, mirroring an in-flight mission.
  defp finished?(%Span{t1: nil}), do: false
  defp finished?(%Span{}), do: true

  defp exec(event, measurements, metadata), do: :telemetry.execute(event, measurements, metadata)
end