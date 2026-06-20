defmodule SpellAgent.Hist.Node do
  @moduledoc """
  One realized cell of a conversation — a single `PtcRunner.Turn` after handle
  realization (PLAN-001, C1).

  A node is the homoiconic unit: it carries the PTC-Lisp `form` the model emitted
  (code-as-data, re-evaluable / structurally queryable), the `binds` delta that
  form introduced into the live environment, the `sees` (recorded tool effects),
  and the `say` prose. Branch structure lives in `parent_id` — NOT in any storage
  engine's nesting — so the same DAG round-trips through any `Hist.Store` impl.

  ## Realization invariant

  No node ever holds a live `%PtcRunner.Lisp.Handle{}`. The runtime freezes the
  whole `Step` AT THE OWNER via `PtcRunner.Step.freeze/1` (called in
  `SpellAgent.Session` before recording) while the parked term is guaranteed
  live, because the `HandleStore` session bucket cold-evicts + tombstones parked
  values — a stored handle reference would dangle on resume. `binds`, `result`,
  and `sees` are therefore always self-contained data; an unrealizable handle
  becomes a `{:__frozen_unrealized__, reason, meta}` tombstone
  (`PtcRunner.Lisp.Handle.unrealized?/1`).

  ## Identity

  `id` is a content hash of `form_src <> parent_id`: stable across sessions, so two
  branches (or two sessions) that ran the same program on the same parent collapse
  to one id. This is the dedup / multi-session union key (`[:hist, :index, :hash]`).
  """

  @type kind :: :turn | :run | :llm | :tool
  @type status :: :ok | :error | :retry

  @typedoc """
  The user message that OPENED the step this node leads. Only the head node of a
  recorded step (the first turn after a user prompt) carries it; interior turns
  leave it `nil`. This is what lets the chat lens interleave a faithful
  `user -> assistant...` transcript across many runs without a separate node kind:
  a prompt is an attribute of where a step begins, not a cell of its own.
  """
  @type prompt :: String.t() | nil

  @type t :: %__MODULE__{
          id: String.t(),
          session: String.t(),
          parent_id: String.t() | nil,
          seq: non_neg_integer(),
          kind: kind(),
          prompt: String.t() | nil,
          status: status(),
          form: term(),
          form_src: String.t() | nil,
          binds: map(),
          result: term(),
          sees: [map()],
          prints: [String.t()],
          say: String.t() | nil,
          raw_response: String.t() | nil,
          tools_defined: [String.t()],
          span_root: map() | nil,
          tokens: %{input: integer(), output: integer()} | nil,
          t: integer()
        }

  @doc """
  Apply a node's `binds` delta onto a cumulative env by merging new/changed
  bindings (PLAN-008 SEAM 1). `binds` is a runtime-emitted def-delta
  (`introduced` + `changed` from `turn.def_delta`), which can only ADD or REBIND
  a name -- PTC has no `undef`, so there is no deletion-by-omission to honor and
  the fold is a plain merge. This is the single fold semantics shared by the
  recorder (computing a parent's cumulative env) and `Hist.Reconstitute`
  (rebuilding env at a cursor).

  (Historical: the BUG-001 B1 `deleted_marker` sentinel existed only because the
  old snapshot-diff could observe a key vanish; a source-emitted delta never
  can, so the marker is gone and this is merge-only.)
  """
  @spec apply_binds(map(), map()) :: map()
  def apply_binds(env, binds), do: Map.merge(env, binds)

  @enforce_keys [:id, :session, :seq]
  defstruct id: nil,
            session: nil,
            parent_id: nil,
            seq: 0,
            kind: :turn,
            status: :ok,
            prompt: nil,
            form: nil,
            form_src: nil,
            binds: %{},
            result: nil,
            sees: [],
            prints: [],
            say: nil,
            raw_response: nil,
            tools_defined: [],
            span_root: nil,
            tokens: nil,
            t: 0
end
