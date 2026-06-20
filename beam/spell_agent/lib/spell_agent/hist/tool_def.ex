defmodule SpellAgent.Hist.ToolDef do
  @moduledoc """
  A durable record of a tool the agent authored at runtime (PLAN-001, C3).

  `SpellAgent.ToolRegistry` holds `:ptc` entries (PTC-Lisp source-as-data) but is
  session-scoped and in-memory — its own moduledoc says "durable storage is a
  follow-up". This struct is that follow-up: a promoted tool survives the session.

  `scope` distinguishes a `:session` tool (authored, used here) from a `:durable`
  one (promoted to resolve in every future session, like a built-in). `stats`
  carries usage pulled from the span record (calls / errors) so promotion /
  pruning decisions are evidence-based.
  """

  @type scope :: :session | :durable

  @type t :: %__MODULE__{
          name: String.t(),
          params: [atom()],
          doc: String.t() | nil,
          source: String.t(),
          origin: %{session: String.t(), node_id: String.t()} | nil,
          scope: scope(),
          stats: %{calls: non_neg_integer(), errors: non_neg_integer()},
          t: integer()
        }

  @enforce_keys [:name, :source]
  defstruct name: nil,
            params: [],
            doc: nil,
            source: nil,
            origin: nil,
            scope: :session,
            stats: %{calls: 0, errors: 0},
            t: 0
end
