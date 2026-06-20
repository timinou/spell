defmodule SpellAgent.Hist.Session do
  @moduledoc """
  A recorded agent session — the root of one conversation's node DAG (PLAN-001).

  `cursors` is the mark-ring / multi-cursor map: a named pointer (`:main` is the
  live conversation tip) to a `node_id`. Moving a cursor is how navigation and
  resume target a slice; alternate cursors (a speculative lane, a bookmark) are
  extra entries. The root→cursor path of nodes is "the conversation"; everything
  off it is latent history.
  """

  @type t :: %__MODULE__{
          id: String.t(),
          prompt: String.t() | nil,
          t0: integer(),
          model: String.t() | nil,
          cursors: %{optional(atom()) => String.t()},
          meta: map()
        }

  @enforce_keys [:id]
  defstruct id: nil,
            prompt: nil,
            t0: 0,
            model: nil,
            cursors: %{},
            meta: %{}
end
