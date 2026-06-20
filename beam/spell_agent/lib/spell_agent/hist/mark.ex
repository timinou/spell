defmodule SpellAgent.Hist.Mark do
  @moduledoc """
  A named, semantically-significant node — the mark-ring (PLAN-001).

  Where a cursor is a *positional* pointer (where you are), a mark is a *semantic*
  one (why a place matters). Kinds:

    * `:decision`   — a fork with rationale ("chose edit over find, here's why")
    * `:scar`       — a dead-end worth remembering NOT to retry (negative knowledge)
    * `:clearing`   — a convergence point: many paths met here → distillation target
    * `:checkpoint` — a state worth replaying to / resuming from

  Recall jumps mark-to-mark; distillation (`Crystal`) folds the subtree under a
  `:clearing`.
  """

  @type kind :: :decision | :scar | :clearing | :checkpoint

  @type t :: %__MODULE__{
          id: String.t(),
          session: String.t(),
          node_id: String.t(),
          kind: kind(),
          note: String.t() | nil,
          t: integer()
        }

  @enforce_keys [:id, :session, :node_id, :kind]
  defstruct id: nil, session: nil, node_id: nil, kind: nil, note: nil, t: 0
end
