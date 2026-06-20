defmodule SpellAgent.Hist.View do
  @moduledoc """
  A reconstituted view of a conversation at one cursor (PLAN-001, C1).

  The typed result of `SpellAgent.Hist.Reconstitute.at/3` (and the `Hist.resume/3`
  facade). It is a *projection*, never storage: a pure fold over the recorded node
  slice, carrying everything a caller needs to bring a conversation back to life —
  the folded def `env`, the runtime-authored `tools` live at the cursor, the
  faithful `messages` transcript (user + assistant, in path order), and the raw
  `nodes` slice for renderers that want the cells themselves.

  Why a struct and not a bare map: this is the substrate's primary consumption
  type (the TUI resumes from it, the `hist/*` namespace reads fields off it). A
  named struct gives callers a type to pattern-match, compile-time field checks,
  and a single place to document what "a reconstituted conversation" contains. A
  struct is still a map, so existing `%{env: env} = view` patterns keep working.

  ## Fields

    * `session_id` — the session this view was rebuilt from.
    * `cursor`     — the named cursor folded to (`:main` is the live tip).
    * `tip`        — the cursor `Node` itself (last of `nodes`); `nil` only for an
      empty slice. Renderers highlight it as "where we are now".
    * `env`        — folded def environment at the cursor (realized data, no handles).
    * `tools`      — `ToolDef`s for the runtime-authored tools live at the cursor.
    * `messages`   — the slice as an interleaved chat transcript (the chat lens).
    * `nodes`      — the root→cursor slice, root first (the conversation path).
  """

  alias SpellAgent.Hist.{Node, ToolDef}

  @type message :: %{role: :user | :assistant, content: String.t()}

  @type t :: %__MODULE__{
          session_id: String.t(),
          cursor: atom(),
          tip: Node.t() | nil,
          env: map(),
          tools: [ToolDef.t()],
          messages: [message()],
          nodes: [Node.t()]
        }

  @enforce_keys [:session_id]
  defstruct session_id: nil,
            cursor: :main,
            tip: nil,
            env: %{},
            tools: [],
            messages: [],
            nodes: []
end
