defmodule SpellAgent.Hist.Cont do
  @moduledoc """
  The L0 continuation buffer of a conversation — the verbatim replay tape + the
  threaded `def` environment (PLAN-006, linear continuation).

  ## Why this exists beside the node DAG

  `Hist` keeps a conversation at TWO fidelities, and they are not interchangeable:

    * **L1 — the `Node` DAG.** Homoiconic, editable, branchable. Each node carries
      the PTC-Lisp `form`, the `binds` delta, the `say` prose. The chat lens
      (`Reconstitute.to_messages/1`) projects it for DISPLAY — but it is LOSSY: it
      drops tool calls, tool results, and programs, keeping only user prompt +
      assistant prose. Faithful for a scrollback pane; WRONG as an LLM feed (the
      model would forget every action it took, keeping only its conclusions).

    * **L0 — this `Cont`.** The verbatim `tape` (`step.messages` with tool_use /
      tool_result blocks intact, system message stripped) plus `memory` (the `def`
      env after the run). This is what replays into the NEXT turn so the model
      sees the real conversation — its own programs, the tools it called, what they
      returned — not a summary of it.

  The two are siblings over the same turns (the L1 nodes are distilled from the
  same `step` whose messages become this tape). For the linear build, L0 is the
  feed-forward source of truth; an edited/branched suffix reconstructing the tape
  from L1 is the deferred upgrade (PLAN-006 FUP-EDIT-REFOLD).

  ## Lifecycle

  Single-valued per session, keyed `{:cont, session_id}`, OVERWRITTEN each turn
  (the tape is cumulative — `step.messages` already contains the prior tape plus
  the new turn — so the latest write supersedes). It tracks the `:main` lane only;
  alternate cursors reconstruct from L1 (FUP). Realized handle-free before persist
  via `PtcRunner.Lisp.Handle.deep_realize/1`, same invariant as `Node`, so a
  resume never dangles.
  """

  @typedoc "A replayable LLM message in SubAgent native shape (role + content, possibly tool blocks)."
  @type message :: %{optional(atom()) => term()}

  @type t :: %__MODULE__{
          session: String.t(),
          tape: [message()],
          memory: map(),
          t: integer()
        }

  @enforce_keys [:session]
  defstruct session: nil, tape: [], memory: %{}, t: 0
end
