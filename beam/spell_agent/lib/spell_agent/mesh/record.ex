defmodule SpellAgent.Mesh.Record do
  @moduledoc """
  One cell of the agent mesh's stigmergic blackboard (PROJ-006, FEAT-008).

  A mesh record is the unit independent sessions exchange WITHOUT messaging each
  other: every session writes records to a shared `region` and reads the region
  back. The record is frozen, pure data — the same realization invariant the Hist
  substrate enforces (`SpellAgent.Hist.Node`): no live pid, reference, or
  `PtcRunner.Lisp.Handle` ever lands on the blackboard, because a blackboard cell
  must be replicable across processes and BEAM nodes.

  ## Identity is a STORE SEQUENCE, not a content hash (oracle P2.2)

  The store key is `{:mesh, region, seq}` where `seq` is a per-region monotonic
  integer the STORE assigns at put time (`SpellAgent.Mesh.Store`, FEAT-009), NOT a
  content hash. This is load-bearing: two `:claim` records for the same work MUST
  coexist so claim arbitration can see the contention — a content-addressed key
  would collapse them and make the fold blind. `seq` is therefore `nil` on a fresh
  record and stamped by the store.

  `content_hash` is a separate FIELD used only to DEDUP the kinds where identical
  content should collapse (`:finding`, the first `:goal`, `:verdict`) via the
  store's `{:mesh_hash, region, h}` index. The existing Hist `{:hash, h}` node
  index is never touched by mesh code.

  ## The five kinds

    * `:goal`      — an objective posted to the region, kept active (first post
                     monotone; re-goaling is an owner-serialized control op).
    * `:finding`   — a result/observation contributed to the region (pure G-Set).
    * `:claim`     — "this session intends to own work W" (append; resolve-by-fold).
    * `:verdict`   — a collective non-monotone decision (consensus only).
    * `:intention` — "when predicate P holds, run action A" (a standing trigger).

  See `docs/agent-mesh-theory/02-blackboard-substrate.org` §2 for the taxonomy and
  `08-implementation.org` §A0 for the corrections this module implements.
  """

  alias SpellAgent.Mesh.Record

  @type kind :: :goal | :finding | :claim | :verdict | :intention

  @type t :: %__MODULE__{
          region: String.t(),
          kind: kind(),
          seq: non_neg_integer() | nil,
          content_hash: String.t(),
          author: String.t() | nil,
          t: integer(),
          payload: map(),
          parent: String.t() | nil,
          watermark: non_neg_integer() | nil,
          sealed: boolean()
        }

  @enforce_keys [:region, :kind, :content_hash, :payload]
  defstruct region: nil,
            kind: nil,
            seq: nil,
            content_hash: nil,
            author: nil,
            t: nil,
            payload: %{},
            parent: nil,
            watermark: nil,
            sealed: false

  @kinds [:goal, :finding, :claim, :verdict, :intention]

  @doc "The kinds whose identical content should DEDUP (collapse) in the store."
  @spec dedup_kinds() :: [kind()]
  def dedup_kinds, do: [:goal, :finding, :verdict]

  @doc """
  Build a fresh record (`seq: nil` — the store stamps the sequence at put time).

  Stamps `author` (the writing session id), `t` (wall-clock ms, human-facing only,
  never used for ordering), and `content_hash`. Raises if `kind` is unknown or if
  the payload carries a non-serializable term (a live pid / reference / function /
  port) — the frozen-data invariant.

  Options: `:author`, `:parent`, `:watermark`, `:sealed`.
  """
  @spec new(kind(), String.t(), map(), keyword()) :: t()
  def new(kind, region, payload, opts \\ [])

  def new(kind, region, payload, opts)
      when kind in @kinds and is_binary(region) and is_map(payload) do
    :ok = ensure_frozen!(payload)

    %Record{
      region: region,
      kind: kind,
      seq: nil,
      content_hash: content_hash(region, payload),
      author: opts[:author],
      t: opts[:t] || System.system_time(:millisecond),
      payload: payload,
      parent: opts[:parent],
      watermark: opts[:watermark],
      sealed: Keyword.get(opts, :sealed, false)
    }
  end

  def new(kind, _region, _payload, _opts) when kind not in @kinds do
    raise ArgumentError,
          "unknown mesh record kind #{inspect(kind)}; expected one of #{inspect(@kinds)}"
  end

  @doc """
  Content hash of a record's `payload` within its `region` — a FIELD, never the
  store key. Used to dedup `dedup_kinds/0` records via the store's `{:mesh_hash}`
  index. Deterministic over the canonicalized payload (NOT natural-language
  normalization — a structured-payload term encode).
  """
  @spec content_hash(String.t(), map()) :: String.t()
  def content_hash(region, payload) when is_binary(region) and is_map(payload) do
    bin = :erlang.term_to_binary(canonical(payload), [:deterministic])
    :crypto.hash(:sha256, ["mesh\n", region, "\n", bin]) |> Base.encode16(case: :lower)
  end

  @doc """
  Canonicalize a payload for hashing: stringify keys and atom leaf values, sort
  map keys, so `%{risk: :high}` and `%{"risk" => "high"}` hash identically. Leaves
  numbers, booleans, and binaries intact; recurses into maps and lists.
  """
  @spec canonical(term()) :: term()
  def canonical(map) when is_map(map) do
    map
    |> Enum.map(fn {k, v} -> {canonical_key(k), canonical(v)} end)
    |> Enum.sort_by(fn {k, _} -> k end)
  end

  def canonical(list) when is_list(list), do: Enum.map(list, &canonical/1)

  def canonical(atom) when is_atom(atom) and atom not in [true, false, nil],
    do: Atom.to_string(atom)

  def canonical(other), do: other

  defp canonical_key(k) when is_atom(k), do: Atom.to_string(k)
  defp canonical_key(k) when is_binary(k), do: k
  defp canonical_key(k), do: to_string(k)

  # The frozen-data guard: a blackboard cell must be pure, replicable data. Reject
  # any non-serializable term so an unrealizable handle/pid never reaches the store.
  defp ensure_frozen!(term) do
    walk_frozen!(term)
    :ok
  end

  defp walk_frozen!(term)
       when is_pid(term) or is_reference(term) or is_port(term) or is_function(term) do
    raise ArgumentError,
          "mesh record payload must be frozen data; got a live #{frozen_kind(term)} " <>
            "(no pid/ref/port/fun on the blackboard — the realization invariant)"
  end

  defp walk_frozen!(map) when is_map(map) do
    Enum.each(map, fn {k, v} ->
      walk_frozen!(k)
      walk_frozen!(v)
    end)
  end

  defp walk_frozen!(list) when is_list(list), do: Enum.each(list, &walk_frozen!/1)

  defp walk_frozen!(tuple) when is_tuple(tuple),
    do: tuple |> Tuple.to_list() |> Enum.each(&walk_frozen!/1)

  defp walk_frozen!(_scalar), do: :ok

  defp frozen_kind(t) when is_pid(t), do: "pid"
  defp frozen_kind(t) when is_reference(t), do: "reference"
  defp frozen_kind(t) when is_port(t), do: "port"
  defp frozen_kind(t) when is_function(t), do: "function"
end
