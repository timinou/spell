defmodule SpellAgent.Hist.Snapshot do
  @moduledoc """
  An environment keyframe (PLAN-001, C1).

  Reconstituting the live env by folding `binds` from the root every time is O(depth).
  A snapshot records the FULL folded (realized) environment at a node, so
  `Hist.Reconstitute` starts from the nearest snapshot ≤ the cursor and folds only
  the tail — O(distance-to-snapshot). Video-keyframe / git-pack semantics.

  `env` is fully realized data (no handles); `tools` is the set of tool names live
  at this point, restored alongside the bindings.
  """

  @type t :: %__MODULE__{
          session: String.t(),
          node_id: String.t(),
          env: map(),
          tools: [String.t()],
          t: integer()
        }

  @enforce_keys [:session, :node_id]
  defstruct session: nil, node_id: nil, env: %{}, tools: [], t: 0
end
