defmodule SpellAgent.Loop do
  @moduledoc """
  A4 self-continuation — the mind authors its own next prompt and re-enters the
  loop (PLAN-025 W4, FEAT-045).

  The agency ladder so far: A2 (`clock/*`) is a TIME-fused re-entry (the body
  schedules a wake), A3 (`black/watch`) is a CONDITION-fused re-entry. A4 is the
  SELF-directed one: at the end of a turn the mind decides "I am not done —
  continue with THIS next prompt," with no external fuse.

  ## Surface (the homoiconic verb)

      (return (tool/loop/continue {:prompt "now do the next part"}))

  `loop/continue` returns a tagged value `%{"__loop_continue__" => prompt}`. When
  a mission's terminal `(return …)` value carries that tag, `SpellAgent.Session`
  re-enters `run/2` for the SAME session with the mind-authored prompt — the tape
  continues (Hist.continuation replays it), the def-env carries forward, and the
  new prompt is the next user turn.

  ## Why a Session-level re-entry (not a ptc_runner loop patch)

  This reuses the EXACT re-entry seam `Clock.fire` uses (a fresh `Session.run`
  with a new prompt on the same session id) rather than surgery inside the
  vendored `ptc_runner` turn loop across its three transports. One detonator, one
  budget, one durable seam — the design the FEAT-045 investigation recommended.
  The continue is therefore a turn CONTINUATION at the mission boundary, exactly
  where the reduction rate-controller (FEAT-036) also sits, so the same
  reduce/cache decision applies to the continued tape.

  ## The hard safety rail (A4 cannot ship without it)

  A self-continuing loop is the classic runaway. Two bounds apply:

    * The per-continue TURN + TOKEN budget (FEAT-043) is enforced by every
      re-entered `Session.run`, and a child/continue budget CLAMPS to the
      parent's remaining (capability + resource only narrow).
    * A CONTINUE-DEPTH cap (`@max_continues`) bounds the number of self-continues
      in one chain independently of the token budget, so even a cheap loop cannot
      spin forever. Hitting the cap ends the chain with the last turn's result
      plus a surfaced note (never a silent stall, never an infinite loop).
  """

  # A distinctive, single-purpose tag. Namespaced so an ordinary tool result is
  # vanishingly unlikely to collide, and `signal/1` additionally requires it to be
  # the SOLE key (a genuine loop/continue value is EXACTLY `%{tag => prompt}`) so a
  # map that merely CONTAINS the key is not mistaken for a continue (review S4 P2).
  @continue_tag "__spell_loop_continue__"

  # The maximum number of self-continues in one chain. A generous ceiling for a
  # legitimate multi-step self-directed task; the real economic bound is the
  # token/turn budget (FEAT-043). This cap is the belt-and-suspenders guard that
  # a runaway cannot exceed regardless of budget.
  @max_continues 25

  @doc "The `loop/*` verb tool map (session-agnostic; the signal is pure data)."
  @spec verbs() :: %{optional(String.t()) => (map() -> term())}
  def verbs do
    %{"loop/continue" => &continue/1}
  end

  @doc "Inventory rows for the capability description."
  @spec inventory() :: [map()]
  def inventory do
    [
      %{
        "name" => "tool/loop/continue",
        "params" => ["prompt"],
        "doc" =>
          "Self-continue: end this turn and re-enter the loop with a prompt YOU " <>
            "author (same session, tape continues). Use as the terminal value: " <>
            "(return (tool/loop/continue {:prompt \"next step\"})). Bounded by the " <>
            "turn/token budget + a continue-depth cap.",
        "kind" => "native"
      }
    ]
  end

  @doc """
  The `loop/continue` verb: produce the continuation signal carrying the
  mind-authored `:prompt`. A missing/blank prompt yields an error map (the mind
  must say WHAT to continue with — a continue with no direction is a stall).
  """
  @spec continue(map()) :: map()
  def continue(args) when is_map(args) do
    case Map.get(args, "prompt") || Map.get(args, :prompt) do
      p when is_binary(p) and p != "" -> %{@continue_tag => p}
      _ -> %{"error" => "loop/continue requires a non-empty :prompt (the next step to run)"}
    end
  end

  @doc """
  If `value` is a continuation signal, return `{:continue, prompt}`; else `:halt`.
  `Session` calls this on a terminal return value to decide whether to re-enter.
  """
  @spec signal(term()) :: {:continue, String.t()} | :halt
  def signal(%{@continue_tag => prompt} = m)
      when is_binary(prompt) and prompt != "" and map_size(m) == 1,
      do: {:continue, prompt}

  def signal(_), do: :halt

  @doc "The continue-depth cap (the runaway guard independent of the token budget)."
  @spec max_continues() :: pos_integer()
  def max_continues, do: @max_continues
end
