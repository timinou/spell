defmodule SpellAgent.Hist.RateController do
  @moduledoc """
  The activation seam for the reduction/compaction engine (PLAN-025 W2,
  FEAT-036).

  PLAN-018 built the whole video-encoding compaction model \u2014 `Mission.decide`
  (the zero-inference I-frame/P-frame rate-controller), `hist/reducibility` (the
  cheap estimate), `hist/reduce` (the lossless/lossy fold), and
  `Mission.memoized_reduce` (the keyframe memo) \u2014 but nothing DROVE it: the verbs
  were agent-callable, yet no scheduler ran the decision, so every mission
  replayed the full verbatim tape until the context window overflowed. This module
  is that scheduler.

  ## Where it runs

  At the MISSION boundary in `SpellAgent.Session.run/2` \u2014 the point where the
  prior conversation tape is loaded (`Hist.continuation`) and about to be fed into
  the next `SubAgent.run`. That is the natural cache/reduce seam: each
  `Session.run` is one user-visible turn, and the Anthropic cache economics
  (P-frame read ~0.1x vs I-frame keyframe write ~1.25x) are a per-mission
  decision. The inner SubAgent loop keeps caching continuously between missions;
  this controller decides whether THIS mission starts from a fresh keyframe.

  ## The decision (zero inference, best-effort)

      tape (from Hist.continuation)
        -> reducibility estimate (hist/reducibility, cheap, no LLM)
        -> Mission.decide(estimate + remaining_turns + window ceilings)
        -> :cache            -> feed the tape unchanged (P-frame)
           {:reduce, tier}   -> memoized_reduce -> feed the reduced tape (I-frame)

  Every step degrades safely: a failed estimate, a `hist.auto_reduce`-off config,
  a malformed reduce \u2014 any of them falls back to the ORIGINAL tape. A worse cache
  is never a dead mission (the never-brick rule). The decision performs NO LLM
  call, so activation adds no per-mission latency beyond the cheap estimate.

  ## What "remaining_turns" means here

  The economic trigger `K` is the expected number of future P-frames a keyframe
  would amortize over. We approximate it with the session's turn budget
  (`max_turns`) \u2014 the ceiling on how many more turns this mission may run. A tighter
  estimate (turns actually left across the whole conversation) is a future
  refinement; the budget is a sound upper bound that keeps the controller from
  reducing when few turns remain (where a keyframe can't pay off).
  """

  alias SpellAgent.{Config, Mission}
  alias SpellAgent.Hist.Namespace, as: HistNs

  @typedoc "The controller's outcome for a mission's starting tape."
  @type outcome :: %{
          tape: list(),
          decision: Mission.decision(),
          reduced?: boolean()
        }

  @doc """
  Decide and (if warranted) reduce the starting `tape` for a mission.

  Returns `%{tape, decision, reduced?}` \u2014 the (possibly reduced) tape to feed the
  SubAgent, the rate-controller verdict, and whether a reduction was applied. On
  ANY failure or when auto-reduce is disabled, returns the original tape with
  `decision: :cache, reduced?: false`.

  ## Params
    * `impl`        \u2014 the `Hist.Store` implementation module.
    * `session_id`  \u2014 the conversation id.
    * `tape`        \u2014 the verbatim continuation tape (from `Hist.continuation`).
    * `max_turns`   \u2014 this mission's turn budget (the `K` economic input).
  """
  @spec run(module(), String.t(), list(), pos_integer()) :: outcome()
  def run(impl, session_id, tape, max_turns) do
    cond do
      not enabled?() ->
        cache(tape)

      tape == [] ->
        # A cold start has nothing to reduce.
        cache(tape)

      true ->
        decide_and_apply(impl, session_id, tape, max_turns)
    end
  rescue
    # Never let the controller crash a mission: any unexpected failure falls back
    # to the verbatim tape (the never-brick rule).
    _ -> cache(tape)
  catch
    _, _ -> cache(tape)
  end

  # --- internals -------------------------------------------------------------

  defp decide_and_apply(impl, session_id, tape, max_turns) do
    estimate = safe_reducibility(impl, session_id)

    inputs = %{
      tok_full: num(estimate, "tok_full", 0),
      tok_reduced: num(estimate, "tok_reduced", 0),
      # The economic input K — expected future P-frames a keyframe amortizes over.
      # `max_turns` is an UPPER BOUND (turns this mission MAY run), so the pure
      # economic rung (K > K*) can over-fire on a short answer-only mission (review
      # S2 P2). Two things bound the downside: (a) the genuine-reduction guard in
      # apply_reduce rejects a reduce that does not actually shrink the tape, and
      # (b) memoized_reduce makes a keyframe a ONE-TIME cost reused by every future
      # mission at the same watermark — so a keyframe written on a short mission is
      # amortized across the CONVERSATION, not just this mission's inner turns. The
      # pressure rungs (soft/hard overflow) do not read K and are always correct.
      # A turns-actually-left estimate is a future refinement (see the W2 FUP).
      remaining_turns: max_turns,
      window_soft: window(:soft),
      window_hard: window(:hard)
    }

    case Mission.decide(inputs) do
      :cache ->
        %{tape: tape, decision: :cache, reduced?: false}

      {:reduce, tier} = decision ->
        apply_reduce(impl, session_id, tape, tier, decision)
    end
  end

  defp apply_reduce(impl, session_id, tape, tier, decision) do
    # Memoize on (session, watermark, policy) so a revisit at the same point is a
    # free lookup and never recomputes the fold.
    watermark = length(tape)
    policy_hash = policy_hash(tier)

    reduced =
      Mission.memoized_reduce(impl, session_id, watermark, policy_hash, fn ->
        HistNs.reduce(impl, session_id, %{"tier" => Atom.to_string(tier)})
      end)

    # Accept the reduced tape ONLY if it is a genuine WIN over the verbatim tape.
    # `hist/reduce` degrades to an UNREDUCED refold on a malformed node (its own
    # best-effort rescue), and that refold is NOT byte-identical to the live
    # continuation tape (review S2 P1). Feeding it would swap a working verbatim
    # tape for a reconstructed one that shrank nothing — a lose-lose. So require
    # the reduced tape to be a real improvement (strictly smaller estimated size);
    # otherwise keep the verbatim tape unchanged (cache-neutral fallback).
    case reduced do
      msgs when is_list(msgs) and msgs != [] ->
        if genuine_reduction?(msgs, tape) do
          %{tape: msgs, decision: decision, reduced?: true}
        else
          %{tape: tape, decision: decision, reduced?: false}
        end

      _ ->
        # An error map, empty, or non-list result -> keep the verbatim tape.
        %{tape: tape, decision: decision, reduced?: false}
    end
  end

  # A reduction is genuine iff its serialized size is strictly smaller than the
  # verbatim tape's. An unreduced refold (the hist/reduce error fallback) has ~the
  # same or larger size, so this rejects it and keeps the verbatim tape. Byte size
  # of the term is a cheap, monotone proxy for wire cost.
  defp genuine_reduction?(reduced, verbatim) do
    :erlang.external_size(reduced) < :erlang.external_size(verbatim)
  rescue
    _ -> false
  end

  defp safe_reducibility(impl, session_id) do
    case HistNs.reducibility(impl, session_id, %{}) do
      m when is_map(m) -> m
      _ -> %{}
    end
  rescue
    _ -> %{}
  end

  # A stable digest of EVERY reduction-policy input for the memo key, so editing
  # ANY policy invalidates the memo (review S2: the reduced value depends on more
  # than the reducer sources). The reduced tape is a pure function of:
  #   * the tier,
  #   * the lens/reducer sources (reducibility/recite .ptc),
  #   * the pipeline ORDER (pipeline.ptc, via Reduce.lossless),
  #   * the effect TAXONOMY (effect_classes.ptc, via restorability),
  #   * the spill THRESHOLD (hist.spill_threshold config, via Spill).
  # phash2 is stable across BEAM restarts, so the memo survives a restart and only
  # a genuine policy change busts it.
  defp policy_hash(tier) do
    fingerprint = {
      tier,
      SpellAgent.Hist.Lens.reducer_sources(),
      SpellAgent.Hist.Reduce.pipeline_order(),
      SpellAgent.Hist.Effect.tables(),
      SpellAgent.Config.get("hist.spill_threshold")
    }

    fingerprint |> :erlang.phash2() |> Integer.to_string(16)
  rescue
    _ -> Atom.to_string(tier)
  end

  defp enabled?, do: Config.get("hist.auto_reduce") == true

  defp window(:soft), do: window_value(Config.get("hist.window_soft"))
  defp window(:hard), do: window_value(Config.get("hist.window_hard"))

  defp window_value(n) when is_integer(n) and n > 0, do: n
  defp window_value(_), do: :infinity

  defp cache(tape), do: %{tape: tape, decision: :cache, reduced?: false}

  defp num(map, key, default) do
    case Map.get(map, key) do
      n when is_number(n) -> n
      _ -> default
    end
  end
end
