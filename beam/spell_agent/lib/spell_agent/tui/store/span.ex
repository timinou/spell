defmodule SpellAgent.Tui.Store.Span do
  @moduledoc """
  One node in the live span forest (PLAN-345, spike).

  A span mirrors a single `PtcRunner.SubAgent.Telemetry` span — a `:run`, `:llm`,
  or `:tool` — keyed by its 8-hex `span_id` and linked to its parent by
  `parent_span_id`. Nesting is structural: a tool whose implementation calls
  `SubAgent.run/2` pushes a CHILD run span (its parent is the tool span), so the
  forest captures "inside the insides" — run -> tool -> nested run -> its llm/tool —
  with no special-casing.

  `:turn` events are NOT spans (PtcRunner emits them, tagged with the *run's*
  span_id and a `:turn` integer); they are folded onto the owning run span's
  `:turns` list rather than becoming nodes. See `SpellAgent.Tui.Store`.
  """

  @type kind :: :run | :llm | :tool
  @type status :: :running | :ok | :error

  @type turn :: %{
          number: pos_integer() | nil,
          program: String.t() | nil,
          result_preview: String.t() | nil,
          response: String.t() | nil,
          status: status()
        }

  @type t :: %__MODULE__{
          id: String.t(),
          parent_id: String.t() | nil,
          kind: kind(),
          status: status(),
          label: String.t(),
          t0: integer() | nil,
          t1: integer() | nil,
          meta: map(),
          children: [String.t()],
          turns: [turn()]
        }

  @enforce_keys [:id, :kind]
  defstruct id: nil,
            parent_id: nil,
            kind: nil,
            status: :running,
            label: "",
            t0: nil,
            t1: nil,
            meta: %{},
            children: [],
            turns: []

  @doc "Duration in native time units, or nil while still running."
  @spec duration(t()) :: integer() | nil
  def duration(%__MODULE__{t0: t0, t1: t1}) when is_integer(t0) and is_integer(t1), do: t1 - t0
  def duration(_), do: nil

  @doc "Duration rendered as milliseconds, or `nil` while running."
  @spec duration_ms(t()) :: integer() | nil
  def duration_ms(%__MODULE__{} = span) do
    case duration(span) do
      nil -> nil
      d -> System.convert_time_unit(d, :native, :millisecond)
    end
  end
end
