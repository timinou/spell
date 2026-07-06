defmodule SpellAgent.Budget do
  @moduledoc """
  A per-session resource ceiling — turns and tokens — ENFORCED as a graceful
  early-exit in `SpellAgent.Session.run/2` (PLAN-025 W2, FEAT-043).

  ## The A5 gap this closes

  `max_turns` was already enforced by the `ptc_runner` SubAgent loop
  (`turn_budget` / `check_termination`), but a `cost_ceiling` threaded from a
  clock wake or a spawn was DROPPED by `Session.run` — no token/cost bound was
  ever applied. So a self-continuing wake or a runaway loop had no economic
  backstop. This module makes the ceiling a real, enforced bound the mind cannot
  exceed, which is the precondition for:

    * FEAT-036 (the reduction rate-controller needs a truthful `remaining_turns`)
    * FEAT-045 (`loop/continue` self-continuation is unsafe without an enforced
      ceiling)

  ## What is a ceiling here

  A budget bounds two runtime-observable quantities the SubAgent already meters:

    * `max_turns`  — the turn budget (already enforced; carried here so the whole
      ceiling is one value).
    * `max_tokens` — the cumulative-token ceiling. Wired to the SubAgent's
      `token_limit`, checked per-turn against `%{total_tokens}`; on exceed the run
      ends with `:budget_callback_exceeded` (a graceful stop, never a crash).

  Dollar-cost is intentionally NOT modelled yet (no per-model price table on the
  BEAM side). Tokens are the honest, available proxy; the `cost_ceiling` opt name
  accepted from wakes maps onto `max_tokens`.

  ## Body invariant: capability only narrows

  `clamp/2` bounds a child budget by the parent's REMAINING budget — a child can
  never be granted more turns/tokens than the parent has left, mirroring the
  capability-attenuation rule (D12). The mind authors a request; the body clamps
  it. A child cannot raise its own ceiling.
  """

  @enforce_keys []
  defstruct max_turns: nil, max_tokens: nil

  @type t :: %__MODULE__{
          max_turns: pos_integer() | nil,
          max_tokens: pos_integer() | nil
        }

  @doc """
  Build a budget from `Session.run` opts. Recognizes:

    * `:max_turns`     — turn ceiling.
    * `:max_tokens`    — token ceiling.
    * `:cost_ceiling`  — alias for `:max_tokens` (the key clock wakes thread).

  A `nil` for either dimension means "unbounded on that axis". Returns a struct
  (never nil) so callers can always pattern-match.
  """
  @spec from_opts(keyword()) :: t()
  def from_opts(opts) do
    %__MODULE__{
      max_turns: positive_or_nil(opts[:max_turns]),
      max_tokens: positive_or_nil(opts[:max_tokens] || opts[:cost_ceiling])
    }
  end

  @doc """
  Clamp a requested (child) budget by a parent budget's remaining allowance.

  Each axis becomes the MINIMUM of the request and the parent's value (a present
  parent bound always wins; an absent parent bound lets the request stand). A
  child therefore never exceeds the parent on any axis (D12). `nil` request +
  present parent → inherit the parent's bound.
  """
  @spec clamp(t(), t()) :: t()
  def clamp(%__MODULE__{} = request, %__MODULE__{} = parent) do
    %__MODULE__{
      max_turns: min_bound(request.max_turns, parent.max_turns),
      max_tokens: min_bound(request.max_tokens, parent.max_tokens)
    }
  end

  @doc """
  The runtime options this budget contributes to `PtcRunner.SubAgent.run/2`.

  Emits `token_limit:` (the cumulative-token ceiling) and, when a token ceiling
  is set, `on_budget_exceeded: :fail` so exceeding it ends the run with a clear
  `:budget_callback_exceeded` error rather than silently over-running. `max_turns`
  is applied separately (it is a `SubAgent.new/1` struct field, not a runtime
  opt), so it is NOT emitted here.
  """
  @spec run_opts(t()) :: keyword()
  def run_opts(%__MODULE__{max_tokens: nil}), do: []

  def run_opts(%__MODULE__{max_tokens: max_tokens}) when is_integer(max_tokens) do
    [token_limit: max_tokens, on_budget_exceeded: :fail]
  end

  @doc """
  The effective turn ceiling to hand `SubAgent.new/1` (`max_turns:`), defaulting
  to `default` when this budget leaves turns unbounded.
  """
  @spec turns(t(), pos_integer()) :: pos_integer()
  def turns(%__MODULE__{max_turns: nil}, default), do: default
  def turns(%__MODULE__{max_turns: n}, _default) when is_integer(n) and n > 0, do: n

  # min of two bounds, treating nil as "no bound on this side".
  defp min_bound(nil, nil), do: nil
  defp min_bound(nil, b), do: b
  defp min_bound(a, nil), do: a
  defp min_bound(a, b), do: min(a, b)

  defp positive_or_nil(n) when is_integer(n) and n > 0, do: n
  defp positive_or_nil(_), do: nil
end
