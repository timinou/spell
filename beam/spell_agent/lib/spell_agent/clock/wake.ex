defmodule SpellAgent.Clock.Wake do
  @moduledoc """
  A scheduled self-wake — the durable unit `SpellAgent.Clock` persists (PLAN-014).

  A wake is the mind's intention to be re-entered later: at `fire_at_ms` the Clock
  runs `prompt` in `session_id` (under `budget`), then re-arms (`repeat_ms` set) or
  forgets it (one-shot). Stored at `{:clock, id}` in `Hist.Store`, so a wake
  outlives the scheduler process — and, on a durable store, a BEAM restart.

  Fields:
    * `id`          — opaque wake id (`Hist.Id.rand("wake")`).
    * `fire_at_ms`  — absolute epoch-ms the wake fires at.
    * `session_id`  — the session the woken mission runs in.
    * `prompt`      — the mission text handed to `SpellAgent.run/2` on fire.
    * `budget`      — a string-keyed map (`"turns"`, `"cost_ceiling"`) threaded
      into the run opts and clamped to the body ceiling (A5 folds in here).
    * `repeat_ms`   — repeat interval in ms (`nil` for a one-shot).
    * `created_ms`  — when this (re-)arming was created, for telemetry.
  """

  @enforce_keys [:id, :fire_at_ms, :session_id, :prompt]
  defstruct id: nil,
            fire_at_ms: nil,
            session_id: nil,
            prompt: nil,
            budget: %{},
            repeat_ms: nil,
            created_ms: nil

  @type t :: %__MODULE__{
          id: String.t(),
          fire_at_ms: non_neg_integer(),
          session_id: String.t(),
          prompt: String.t(),
          budget: %{optional(String.t()) => term()},
          repeat_ms: non_neg_integer() | nil,
          created_ms: non_neg_integer() | nil
        }

  @doc "Render a wake as a plain string-keyed map for the `clock/pending` verb."
  @spec render(t()) :: map()
  def render(%__MODULE__{} = w) do
    %{
      "id" => w.id,
      "fire_at" => w.fire_at_ms,
      "session_id" => w.session_id,
      "prompt" => w.prompt,
      "budget" => w.budget,
      "repeat_ms" => w.repeat_ms,
      "repeating" => not is_nil(w.repeat_ms)
    }
  end
end
