defmodule SpellAgent.Hist.Spill do
  @moduledoc """
  The lossy-but-RESTORABLE reduction tier (PLAN-018 W6): result-spill + span-fold.

  Where the W4 lossless tier shrinks the node store without touching the wire
  (per the L1 finding), THIS tier sheds TAPE bytes: it rewrites an over-threshold
  `node.result` \u2014 the dominant token sink the refold emits \u2014 into a compact
  `{node_id, path, digest}` STUB. The full node stays untouched in the store, so
  the stub is a pointer the agent follows back: `hist/recall` (or a direct node
  fetch by id) reconstructs the original payload. Compression becomes a PROPERTY
  of the append-only store, not a discipline \u2014 nothing is destroyed, only the
  feed-forward copy is replaced by a reference.

  ## Restorability is the precondition (the W4 effect class, reused)

  A result may be spilled ONLY when its program is RESTORABLE \u2014 reproducible by
  re-running, so the world can reconstruct the payload. `Effect.restorable_program?/1`
  gates it: a `:read` or `:check` program (cat, grep, mix test) is restorable; a
  `:mutation`, `:external`, or `:unknown` program is NOT (a `date`/`curl`/`rm`
  result has no reproducible path back), so its result is kept verbatim. This is
  the NO-SPILL-FOR-EXTERNAL invariant: restorable compression is valid only when
  the world can reproduce the bytes.

  ## The stub

  A spilled result becomes a map the refold emits as the tool_result content:

      %{
        "spilled"  => true,
        "node_id"  => "<the node whose result this was>",
        "digest"   => "<sha256[0..12] of the original rendered result>",
        "bytes"    => <original size>,
        "hint"     => "re-fetch via (hist/recall ...) or re-run the program"
      }

  The digest lets a consumer verify a recovered payload; `node_id` is the handle.

  ## Errors and small results are never spilled

  A failed turn's result (status :error) is recovery evidence \u2014 kept verbatim. A
  result under the token threshold is not worth a stub (the stub itself costs
  tokens) \u2014 kept verbatim. Both mirror the lossless tier's exemptions.
  """

  alias SpellAgent.Hist.{Effect, Node}

  # Default: spill a restorable result whose rendered form exceeds ~512 tokens
  # (~2KB). Below this the stub is not a net win.
  @default_threshold_tokens 512

  @doc """
  Spill over-threshold, restorable `node.result`s in a slice to stubs.

  Pure over its input (operates on the in-memory slice, never the store), so the
  ORIGINAL nodes in the store are untouched and remain the restore path. Options:

    * `:threshold_tokens` \u2014 minimum estimated result tokens to spill (default 512).

  Returns the slice with spilled results replaced by stub maps; refold then emits
  the stubs in place of the original payloads.
  """
  @spec spill([Node.t()], keyword()) :: [Node.t()]
  def spill(slice, opts \\ []) when is_list(slice) do
    threshold = Keyword.get(opts, :threshold_tokens, @default_threshold_tokens)
    Enum.map(slice, &maybe_spill(&1, threshold))
  end

  @doc """
  Whether a node's result WOULD be spilled at the given threshold (the predicate,
  exposed for the reducibility estimate + tests). True iff the turn succeeded, its
  program is restorable, and its rendered result exceeds the threshold.
  """
  @spec spillable?(Node.t(), non_neg_integer()) :: boolean()
  def spillable?(%Node{status: status, form: form, result: result}, threshold) do
    status == :ok and Effect.restorable_program?(form) and
      result_tokens(result) > threshold
  end

  # --- internals --------------------------------------------------------------

  defp maybe_spill(%Node{} = node, threshold) do
    if spillable?(node, threshold) do
      %{node | result: stub(node)}
    else
      node
    end
  end

  defp stub(%Node{id: id, result: result}) do
    rendered = render(result)

    %{
      "spilled" => true,
      "node_id" => id,
      "digest" => digest(rendered),
      "bytes" => byte_size(rendered),
      "hint" => "re-fetch via (hist/recall ...) or re-run the program"
    }
  end

  defp digest(rendered) do
    :crypto.hash(:sha256, rendered) |> Base.encode16(case: :lower) |> binary_part(0, 12)
  end

  # ~4 chars/token (Metrics.estimate_tokens), over the rendered result.
  defp result_tokens(result) do
    rendered = render(result)
    max(0, div(byte_size(rendered), 4))
  end

  defp render(result) when is_binary(result), do: result
  defp render(result), do: Jason.encode!(jsonable(result))

  # Coerce a non-JSON-encodable result so render never raises (same posture as
  # Refold.jsonable/1).
  defp jsonable(term) do
    case Jason.encode(term) do
      {:ok, _} -> term
      {:error, _} -> inspect(term)
    end
  end
end
