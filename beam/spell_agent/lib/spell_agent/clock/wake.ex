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
    * `allowed`     — the CAPABILITY CEILING the woken turn re-enters under (D12,
      FUP-019): `:all` for an unrestricted root, or a list of base-tool NAMES the
      scheduling session itself held. Threaded into `SpellAgent.run/2` as `:tools`
      so a wake an ATTENUATED child schedules cannot restore the full base surface
      (the re-entry attenuation seam, mirroring the spawn seam BUG-017 closed).
      Only NAMES cross — tool maps are not serializable — and the woken run
      rebuilds the tools from them. A persisted wake carries the ceiling, so it
      survives a BEAM restart.
    * `region`      — the mesh region the woken turn coordinates in (`nil` for a
      plain session), so a child's wake stays in its blackboard context.
  """

  @enforce_keys [:id, :fire_at_ms, :session_id, :prompt]
  defstruct id: nil,
            fire_at_ms: nil,
            session_id: nil,
            prompt: nil,
            budget: %{},
            repeat_ms: nil,
            created_ms: nil,
            allowed: :all,
            region: nil

  @type t :: %__MODULE__{
          id: String.t(),
          fire_at_ms: non_neg_integer(),
          session_id: String.t(),
          prompt: String.t(),
          budget: %{optional(String.t()) => term()},
          repeat_ms: non_neg_integer() | nil,
          created_ms: non_neg_integer() | nil,
          allowed: :all | [String.t()],
          region: String.t() | nil
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
      "repeating" => not is_nil(w.repeat_ms),
      "allowed" => render_allowed(w.allowed),
      "region" => w.region
    }
  end

  # `:all` renders as the string "all" (the unrestricted ceiling); a name list
  # renders as-is. Keeps `clock/pending` output JSON-safe (no bare atom).
  defp render_allowed(:all), do: "all"
  defp render_allowed(names) when is_list(names), do: names
end
