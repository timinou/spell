defmodule SpellAgent.Mission do
  @moduledoc """
  The mission-start rate-controller (PLAN-018 W5): decide, per turn, whether to
  REDUCE the tape (an I-frame keyframe) or CACHE it forward (a P-frame), from cheap
  token estimates and the remaining budget. ZERO inference in the decision.

  ## The video-encoding model

  Caching and compaction are not competing policies; they are the delta and the
  keyframe of one encoding:

    * a REDUCE is an I-FRAME \u2014 expensive (it mutates the prefix, paying a cache
      WRITE), but it becomes the new content-addressed cache anchor.
    * a normal turn is a P-FRAME \u2014 append at the tail, paying only a cache READ
      (~0.1x) off the last keyframe.

  The controller places keyframes: reduce RARELY (only when it amortizes or
  pressure forces it), cache CONTINUOUSLY between keyframes.

  ## The decision ladder (zero inference)

  Given cheap estimates `F` = full-tape tokens, `R` = reduced-tape tokens, and
  `K` = expected remaining turns:

      tok_full > window_hard  -> {:reduce, :lossy}     overflow: cannot cache out of it
      tok_full > window_soft  -> {:reduce, :lossless}  attention-regime guard
      K > K*                  -> {:reduce, :lossless}  the pure economic trigger
      else                    -> :cache                roll the breakpoint, append tail

  ## The economics (Anthropic-shaped: read ~0.1x, cache-write ~1.25x base)

      savings(K) = K * 0.1 * (F - R)  -  max(0, 1.25R - 0.1F)
      break-even  K* = (1.25R - 0.1F) / (0.1 * (F - R))

  Reducing pays a one-time keyframe cost `max(0, 1.25R - 0.1F)` and then saves
  `0.1 * (F - R)` on each of the next `K` P-frames. It is worth it once
  `K > K*`. All inputs are cheap estimates from `hist/reducibility`; `K` from the
  budget. The decision performs NO LLM call.

  ## Restorability tightens the ceiling (the spell_agent edge)

  Because the lossy tier (W6) is RESTORABLE (a spilled result is re-fetchable from
  the store via `hist/recall`), the `window_*` ceilings can be set tighter than a
  destructive-eviction harness could afford: dropping context here is reversible,
  so a lower ceiling is both cheaper and keeps the prompt in the attention-healthy
  regime, with the only downside (look-back) engineered away by restorability.
  """

  # Anthropic-shaped price multipliers (relative to a fresh input token).
  @read_discount 0.1
  @cache_write 1.25

  @typedoc "The rate-controller's per-turn verdict."
  @type decision :: :cache | {:reduce, :lossless | :lossy}

  @typedoc """
  The inputs the decision reads. `tok_full` / `tok_reduced` come from
  `hist/reducibility`; `remaining_turns` from the budget; the ceilings from config.
  """
  @type inputs :: %{
          tok_full: number(),
          tok_reduced: number(),
          remaining_turns: number(),
          window_soft: number(),
          window_hard: number()
        }

  @doc """
  Decide REDUCE vs CACHE for this turn (zero inference).

  Walks the ladder top-to-bottom: hard-overflow -> lossy reduce; soft-overflow ->
  lossless reduce; `K > K*` -> lossless reduce; otherwise cache. A tape with no
  reducible content (`tok_reduced >= tok_full`) can never profit from a reduce, so
  it always caches unless it is over the HARD ceiling (where lossy spill is the
  only way back under budget).
  """
  @spec decide(inputs() | map()) :: decision()
  def decide(stats) when is_map(stats) do
    # Accept the reducer's STRING-keyed stats (hist/reducibility output) as well as
    # atom-keyed inputs, and degrade a missing/garbage field to a neutral default
    # so a failed estimate caches rather than crashing the mission (best-effort
    # posture, S5 swarm finding).
    f = num(stats, :tok_full, 0)
    r = num(stats, :tok_reduced, 0)
    k = num(stats, :remaining_turns, 0)
    soft = num(stats, :window_soft, :infinity)
    hard = num(stats, :window_hard, :infinity)

    cond do
      over?(f, hard) -> {:reduce, :lossy}
      # soft-overflow only warrants a lossless reduce if the tape can ACTUALLY
      # shrink; a pathological estimate where the reduced tape is not smaller
      # (F <= R) cannot relieve the overflow, so cache and let hard overflow force
      # the lossy tier (S5 swarm finding).
      over?(f, soft) and reducible?(f, r) -> {:reduce, :lossless}
      profitable?(f, r, k) -> {:reduce, :lossless}
      true -> :cache
    end
  end

  def decide(_), do: :cache

  @doc """
  The break-even remaining-turn count `K*` above which a reduction amortizes.

  Returns `:infinity` when a reduction can never pay off (no tokens are
  reducible, `F <= R`), so `K > K*` is always false and the controller caches.
  """
  @spec break_even(number(), number()) :: number() | :infinity
  def break_even(f, r) do
    delta = f - r

    if delta <= 0 do
      :infinity
    else
      keyframe_cost = max(0, @cache_write * r - @read_discount * f)
      keyframe_cost / (@read_discount * delta)
    end
  end

  @doc """
  Estimated net token savings of reducing now and caching for `k` P-frames.

  `savings(K) = K * 0.1 * (F - R) - max(0, 1.25R - 0.1F)`. Positive ⇒ reducing
  pays. Used by tests to pin the decision against the closed form, and available
  to a caller that wants the magnitude, not just the verdict.
  """
  @spec savings(number(), number(), number()) :: number()
  def savings(f, r, k) do
    delta = f - r
    keyframe_cost = max(0, @cache_write * r - @read_discount * f)
    k * @read_discount * delta - keyframe_cost
  end

  # A reduce is economically profitable when there are reducible tokens AND the
  # remaining turns exceed the break-even. `:infinity` break-even (nothing
  # reducible) is never exceeded.
  defp profitable?(f, r, k) do
    case break_even(f, r) do
      :infinity -> false
      kstar -> k > kstar
    end
  end

  # There are reducible tokens iff the reduced estimate is strictly smaller.
  defp reducible?(f, r), do: f > r

  # `f > ceiling`, with an :infinity ceiling never exceeded (a missing/garbage
  # ceiling defaults to :infinity -> the overflow rungs do not fire).
  defp over?(_f, :infinity), do: false
  defp over?(f, ceiling) when is_number(f) and is_number(ceiling), do: f > ceiling
  defp over?(_f, _ceiling), do: false

  # Read a numeric field by atom OR string key; a missing/non-numeric value
  # degrades to `default` (so a failed/raw reducibility estimate never crashes
  # decide/1 — it caches). `:infinity` is a valid ceiling default.
  defp num(map, key, default) do
    case fetch_either(map, key) do
      n when is_number(n) -> n
      _ -> default
    end
  end

  defp fetch_either(map, key) do
    case Map.fetch(map, key) do
      {:ok, v} -> v
      :error -> Map.get(map, Atom.to_string(key))
    end
  end

  # --- the reduction memo (PLAN-018 W5) ---------------------------------------

  @doc """
  The memo key for a deterministic reduction at `(session, watermark, policy)`.

  A reduction is a pure value of these three, so the key fully identifies it: a
  revisit at the same watermark + policy is a free lookup. `policy_hash` is a
  short stable digest of the reducer policy (so a policy change invalidates the
  memo without a manual bump).
  """
  @spec memo_key(String.t(), non_neg_integer(), String.t()) ::
          {:reduced, String.t(), non_neg_integer(), String.t()}
  def memo_key(session_id, watermark, policy_hash) do
    {:reduced, session_id, watermark, policy_hash}
  end

  @doc """
  Compute-or-reuse a reduction, memoized at `(session, watermark, policy)`.

  On a hit, returns the stored reduced tape WITHOUT recomputing (the store-side
  "reuse a previously-used header"). On a miss, runs `compute_fn`, stores the
  result, and returns it. Determinism is the contract: the same key MUST map to
  the same value, so `compute_fn` must be a pure function of `(session,
  watermark, policy)`.

  Best-effort: a store read/write failure degrades to a plain compute (the memo
  is an optimization, never a correctness dependency).
  """
  @spec memoized_reduce(
          module(),
          String.t(),
          non_neg_integer(),
          String.t(),
          (-> term())
        ) :: term()
  def memoized_reduce(impl, session_id, watermark, policy_hash, compute_fn)
      when is_function(compute_fn, 0) do
    key = memo_key(session_id, watermark, policy_hash)

    case safe_fetch(impl, key) do
      {:ok, cached} ->
        cached

      :error ->
        computed = compute_fn.()
        safe_put(impl, key, computed)
        computed
    end
  end

  defp safe_fetch(impl, key) do
    SpellAgent.Hist.Store.fetch(impl, key)
  rescue
    _ -> :error
  end

  defp safe_put(impl, key, value) do
    SpellAgent.Hist.Store.put(impl, key, value)
  rescue
    _ -> :ok
  end
end
