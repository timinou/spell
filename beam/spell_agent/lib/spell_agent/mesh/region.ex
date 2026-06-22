defmodule SpellAgent.Mesh.Region do
  @moduledoc """
  Region-id minting — the one parameter that distinguishes Fork A from Fork B
  (PROJ-006, FEAT-008).

  A *region* is a named sub-blackboard: the set of mesh records sharing a `region`
  key. A region is created lazily by the first `black/post` to its id. How the id
  is minted is the WHOLE difference between the two coordination modes:

    * `fork_a/2` — `hash(goal <> parent_session <> nonce)`. Unique per spawn and
      UNFORGEABLE (the random nonce). The id doubles as the write-capability token:
      a child can only write the region whose id its parent handed it. An ISOLATED
      region — the parent's private coordination space for the children it spawned.

    * `fork_b/1` — a RENDEZVOUS id independent sessions can each derive without
      ever referencing one another. It MUST content-address reliably, so it is
      built only from a *structured* key or an *explicit* slug — never from raw
      natural-language prose (see below).

  ## Why fork_b rejects natural-language goals (oracle DC-4)

  `hash(canonical("ship feature X"))` is fundamentally fragile for free text:
  "ship X" vs "Ship Feature X" hash differently (sessions that SHOULD meet never
  rendezvous — a false negative), and aggressive normalization collides distinct
  goals (a false positive). Natural language does not content-address. So
  `fork_b/1` accepts only:

    * `{:structured, term}` — a PR number, file path, commit sha, ticket id: a
      structured subject that content-addresses exactly. This is MOST Fork-B
      triggers (webhook event subjects, resource ids).
    * `{:slug, binary}` — an explicit human coordination key the launcher supplies.

  A bare binary (raw prose) raises, directing the caller to pass a structured key
  or an explicit slug discoverable via `black/query` ("rendezvous is a discovery
  problem, not a hashing problem").
  """

  @hash_len 24

  @doc """
  Mint a Fork-A region id: `hash(goal <> parent_session <> nonce)`.

  The random nonce makes the id unique per call and unforgeable, so holding it is
  the capability to write the region. `goal` and `parent_session` thread provenance
  into the hash but the nonce is what guarantees isolation.
  """
  @spec fork_a(String.t(), String.t()) :: String.t()
  def fork_a(goal, parent_session) when is_binary(goal) and is_binary(parent_session) do
    nonce = :crypto.strong_rand_bytes(16)
    digest(["a\n", goal, "\n", parent_session, "\n", nonce])
  end

  @doc """
  Mint a Fork-B rendezvous region id from a STRUCTURED key or an EXPLICIT slug.

  Independent sessions that pass the same key compute the same id and meet on one
  blackboard. Raises on a bare natural-language binary (DC-4) — the caller must
  pass `{:structured, term}` or `{:slug, binary}`.
  """
  @spec fork_b({:structured, term()} | {:slug, String.t()}) :: String.t()
  def fork_b({:structured, term}) do
    bin =
      :erlang.term_to_binary(SpellAgent.Mesh.Record.canonical(structured_map(term)), [
        :deterministic
      ])

    digest(["b:struct\n", bin])
  end

  def fork_b({:slug, slug}) when is_binary(slug) and slug != "" do
    digest(["b:slug\n", slug])
  end

  def fork_b(raw) when is_binary(raw) do
    raise ArgumentError,
          "fork_b/1 will not hash a natural-language string (DC-4: false negatives/positives). " <>
            "Pass {:structured, term} (PR#, path, sha, ticket) or {:slug, \"explicit-key\"}, " <>
            "or discover an existing region via black/query. Got: #{inspect(raw)}"
  end

  def fork_b(other) do
    raise ArgumentError,
          "fork_b/1 expects {:structured, term} or {:slug, binary}; got #{inspect(other)}"
  end

  @doc """
  Whether `held` (a region id, or a list of held region ids) carries the
  write-capability for `region_id`. Reads are ambient; writing a region requires
  holding its (unforgeable, for Fork A) id. The enforcement point is `black/post`
  (FEAT-010).
  """
  @spec write_cap?(String.t(), String.t() | [String.t()] | nil) :: boolean()
  def write_cap?(region_id, held) when is_binary(region_id) do
    case held do
      ^region_id -> true
      list when is_list(list) -> region_id in list
      _ -> false
    end
  end

  # Wrap a non-map structured key so Record.canonical (which expects a map/list/
  # scalar) handles it uniformly; a map passes through, anything else is boxed.
  defp structured_map(term) when is_map(term), do: term
  defp structured_map(term), do: %{"__k" => term}

  defp digest(iodata) do
    :crypto.hash(:sha256, iodata) |> Base.encode16(case: :lower) |> binary_part(0, @hash_len)
  end
end
