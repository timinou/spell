defmodule SpellAgent.Mesh.Store do
  @moduledoc """
  The mesh's read/write aperture over the EXISTING `SpellAgent.Hist.Store`
  behaviour (PROJ-006, FEAT-009).

  No new storage engine: mesh records ride the same store the conversation history
  uses, so they inherit `Store.Memory` (ETS, single-node) and `Store.Khepri`
  (Ra/Raft, distributed) unchanged — the location-transparency payoff (a capability
  written here against the behaviour works on either impl).

  ## Records are keyed by a STORE-ASSIGNED per-region sequence (oracle P2.2/P2.1)

  `put/2` assigns each record a per-region monotonic `seq` via `Store.incr/2` (an
  atomic counter — ETS `update_counter` / a Khepri transaction), and stores it at
  `{:mesh, region, seq}`. This sequence — NOT a per-session Lamport clock — is the
  region's total order: it is store-owned, so it can never run backwards the way a
  per-session scalar can across nodes, and concurrent writers always get distinct
  seqs (the property claim arbitration depends on). It mirrors how
  `SpellAgent.Hist.Recorder` assigns node `seq` from `max_seq`, but atomic and O(1).

  ## Content dedup is a SEPARATE index, never the Hist {:hash} kind

  For the kinds where identical content should collapse (`Record.dedup_kinds/0` —
  finding, first goal, verdict), `put/2` indexes `{:mesh_hash, region, content_hash}
  => [seq]`. This is a mesh-only index; the Hist `{:hash, h}` node index is never
  touched. `:claim` and `:intention` never dedup — each is a distinct event, kept
  distinct by its unique seq key.
  """

  alias SpellAgent.Hist.Store
  alias SpellAgent.Mesh.Record

  @doc """
  Append a record to its region. Assigns a store-owned monotonic `seq`, stores it
  at `{:mesh, region, seq}`, and (for dedup kinds) indexes its content hash.
  Returns the stored record (with `seq` filled in).

  Refuses to write a region that has been sealed by a terminal verdict (a monotone
  latch); returns `{:error, :sealed}`.
  """
  @spec put(module(), Record.t()) :: {:ok, Record.t()} | {:error, :sealed}
  def put(impl, %Record{region: region} = rec) do
    if sealed?(impl, region) do
      {:error, :sealed}
    else
      seq = Store.incr(impl, {:mesh_seq, region})
      stored = %{rec | seq: seq}
      :ok = Store.put(impl, {:mesh, region, seq}, stored)
      maybe_index_content(impl, stored)
      # A3 (FEAT-021): announce the post so the single-node Mesh.Watcher can eval
      # registered :intention predicates and fire a condition-fused self-wake. The
      # event carries the stored record + its region; emit is best-effort (a
      # handler failure can never fail the write — :telemetry isolates handlers).
      :telemetry.execute([:spell, :mesh, :post], %{seq: seq}, %{region: region, record: stored})
      {:ok, stored}
    end
  end

  @doc "All records in a region, ordered by ascending `seq` (the region total order)."
  @spec region(module(), String.t()) :: [Record.t()]
  def region(impl, region) when is_binary(region) do
    impl
    |> Store.list(:mesh, region)
    |> Enum.sort_by(& &1.seq)
  end

  @doc """
  Every region id that holds at least one record, with a small summary per region
  (record count + per-kind counts). The inspector's top-level index (FEAT-014).
  """
  @spec regions(module()) :: [%{region: String.t(), count: non_neg_integer(), kinds: map()}]
  def regions(impl) do
    impl
    |> Store.list(:mesh, nil)
    |> Enum.group_by(& &1.region)
    |> Enum.map(fn {region, recs} ->
      %{
        region: region,
        count: length(recs),
        kinds: recs |> Enum.frequencies_by(& &1.kind)
      }
    end)
    |> Enum.sort_by(& &1.region)
  end

  @doc "Records of one kind in a region, ascending `seq`."
  @spec by_kind(module(), String.t(), Record.kind()) :: [Record.t()]
  def by_kind(impl, region, kind) do
    impl |> region(region) |> Enum.filter(&(&1.kind == kind))
  end

  @doc """
  Records matching a `%{kind: k, where: %{field => value}}` predicate, ascending
  `seq`. `:kind` is optional; `:where` constrains payload fields (atom/string
  tolerant). This is the content-addressed discovery `black/query` exposes.
  """
  @spec by_match(module(), String.t(), map()) :: [Record.t()]
  def by_match(impl, region, match) when is_map(match) do
    # kind compares against rec.kind (an atom) — read it WITHOUT the atom->string
    # canonicalization fetch_flex applies to payload values; normalize a string
    # kind back to the matching atom instead.
    kind = match |> raw_get(:kind) |> normalize_kind()
    where = raw_get(match, :where) || %{}

    impl
    |> region(region)
    |> Enum.filter(fn rec ->
      (is_nil(kind) or rec.kind == kind) and matches_where?(rec.payload, where)
    end)
  end

  @doc """
  All `:claim` records for a given `work` id in a region (ascending `seq`). The
  caller folds these by `argmin(seq, author)` to elect a winner — `black/claim`.
  """
  @spec claims_for(module(), String.t(), term()) :: [Record.t()]
  def claims_for(impl, region, work) do
    impl
    |> by_kind(region, :claim)
    |> Enum.filter(fn rec -> fetch_flex(rec.payload, :work) == work end)
  end

  @doc """
  Whether the region is sealed (a terminal `:verdict` latched `sealed: true`). A
  sealed region rejects further posts (DC-9). Monotone: sealing only ever latches
  true, so observing it once is enough.
  """
  @spec sealed?(module(), String.t()) :: boolean()
  def sealed?(impl, region) do
    impl |> by_kind(region, :verdict) |> Enum.any?(& &1.sealed)
  end

  @doc "The current max seq in a region (0 if empty) — the seal frontier for decide."
  @spec max_seq(module(), String.t()) :: non_neg_integer()
  def max_seq(impl, region) do
    impl |> Store.list(:mesh, region) |> Enum.map(& &1.seq) |> Enum.max(fn -> 0 end)
  end

  # --- content dedup index (finding / goal / verdict only) ---

  defp maybe_index_content(impl, %Record{kind: kind} = rec) do
    if kind in Record.dedup_kinds() do
      key = {:mesh_hash, rec.region, rec.content_hash}

      prior =
        case Store.fetch(impl, key) do
          {:ok, seqs} when is_list(seqs) -> seqs
          _ -> []
        end

      Store.put(impl, key, Enum.uniq([rec.seq | prior]))
    end

    :ok
  end

  # --- predicate helpers (atom/string-key tolerant, like Hist + Tools) ---

  defp matches_where?(payload, where) when is_map(payload) do
    Enum.all?(where, fn {k, v} -> fetch_flex(payload, k) == canon(v) end)
  end

  defp fetch_flex(map, key) when is_map(map) and is_atom(key) do
    cond do
      Map.has_key?(map, key) -> canon(Map.get(map, key))
      Map.has_key?(map, Atom.to_string(key)) -> canon(Map.get(map, Atom.to_string(key)))
      true -> nil
    end
  end

  defp fetch_flex(map, key) when is_map(map) and is_binary(key) do
    case safe_atom(key) do
      a when is_atom(a) and a != nil ->
        cond do
          Map.has_key?(map, key) -> canon(Map.get(map, key))
          Map.has_key?(map, a) -> canon(Map.get(map, a))
          true -> nil
        end

      _ ->
        if Map.has_key?(map, key), do: canon(Map.get(map, key)), else: nil
    end
  end

  defp fetch_flex(_other, _key), do: nil

  # Raw map fetch tolerant of atom/string KEYS but NOT coercing the VALUE (used for
  # :kind and :where, where the value must keep its native type).
  defp raw_get(map, key) when is_map(map) and is_atom(key) do
    Map.get(map, key) || Map.get(map, Atom.to_string(key))
  end

  defp raw_get(_map, _key), do: nil

  defp normalize_kind(nil), do: nil
  defp normalize_kind(k) when is_atom(k), do: k
  defp normalize_kind(k) when is_binary(k), do: safe_atom(k)

  # Compare atom and string forms equal (so where: %{risk: :high} matches a payload
  # stored with "risk" => "high"), matching Record.canonical's leaf rule.
  defp canon(v) when is_atom(v) and v not in [true, false, nil], do: Atom.to_string(v)
  defp canon(v), do: v

  defp safe_atom(s) do
    String.to_existing_atom(s)
  rescue
    ArgumentError -> nil
  end
end
