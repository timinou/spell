defmodule SpellAgent.Mesh.Consensus do
  @moduledoc """
  `black/decide` — the one true consensus round (PLAN-019 M2, FEAT-012).

  `decide` commits a non-monotone `:verdict` by folding a SEALED snapshot of a
  region's findings. It is Fork B's reconciliation verdict and the exactly-once
  gate for irreversible work (DC-1). Two planes (DC-7):

    * the SESSION plane (findings/claims) is what the verdict folds OVER;
    * the NODE plane is where the election happens (Ra over the Khepri cluster).

  ## Single-node first (this milestone's shipped path)

  With `Store.Memory` (no Ra) or a one-member Ra cluster, `decide` DEGENERATES to:
  seal the watermark, fold locally, write the verdict directly — no real election
  (PT-10 graceful n=1). The SAME code path; the cluster size decides. The
  multi-node Ra election + two-node distribution gate land as a follow-up
  (FUP-020) over this exact seal/id/commit core, which already works on either
  store impl.

  ## The sealed watermark is a STORE SEQ (oracle P1.2)

  The seal is the region's committed per-region store `seq` at seal time
  (`Mesh.Store.max_seq/2`), NOT a Lamport scalar. The fold takes records WHERE
  `seq <= watermark` — a stable, totally-ordered set — so any re-elected leader
  folds the IDENTICAL set and computes the IDENTICAL verdict id. `verdict id =
  hash(region <> question <> watermark)`; a second `decide` at the same watermark
  is a no-op collapse onto the same id (idempotent — DC-8).

  ## The fold is userland PTC (the boundary doctrine)

  `decide`'s `:fold` is a POLICY (which findings, how reduced) so it is authored
  PTC-Lisp run through the SAME sandbox `Hist.Lens` uses: the region's findings
  `seq <= watermark` are MATERIALIZED into string-keyed, JSON-safe maps
  (`project_findings/2`, the `Lens.project_node` analogue — no `%Record{}` struct
  ever crosses into the sandbox), injected as `data/findings`, and the `:fold`
  source is run with `caller: :in_process_v1`. A bad fold is a bad verdict
  payload, never a corrupt commit. When no `:fold` is given, a default fold
  returns the materialized findings + their count (the verdict records what it saw).
  """

  alias SpellAgent.Mesh.{Record, Store}

  @typedoc "A decide outcome."
  @type outcome ::
          {:verdict, String.t(), map()}
          | {:pending, term()}
          | {:error, term()}

  @doc """
  Decide over `region` for `question`, sealing at the current store frontier.

  `args`:
    * `:region`   — the region to decide over (required).
    * `:question` — what is being decided; part of the idempotent verdict id (required).
    * `:fold`     — OPTIONAL PTC-Lisp source folding `data/findings` to a verdict
      payload. Absent -> a default fold (the findings + count).
    * `:store`    — the Hist store impl (required).
    * `:terminal` — when true, the verdict SEALS the region (DC-9): subsequent
      posts are rejected. Default false.
    * `:author`   — the deciding session id (provenance), optional.

  Returns `{:verdict, id, payload}` on commit (idempotent: a re-decide at the same
  watermark returns the existing verdict), or `{:error, reason}`.
  """
  @spec decide(map()) :: outcome()
  def decide(args) when is_map(args) do
    # Serialize the check+fold+commit through the per-node server so two sessions
    # deciding the same (region, question, watermark) concurrently cannot both
    # miss the idempotency check and double-commit (the TOCTOU between
    # existing_verdict and Store.put). The server runs decide_inline/1 in its
    # single mailbox — one critical section at a time. Best-effort: an absent
    # server (a bare unit test) falls back to the inline path (single-process, no
    # contention). The multi-node atomic guarantee is the Ra commit (FUP-020).
    case Process.whereis(SpellAgent.Mesh.Consensus.Server) do
      nil -> decide_inline(args)
      _pid -> SpellAgent.Mesh.Consensus.Server.decide(args)
    end
  catch
    :exit, _ -> decide_inline(args)
  end

  @doc """
  The unserialized decide body. Public so the serializing server can call it in
  its own process; callers should use `decide/1` (which routes through the server).
  """
  @spec decide_inline(map()) :: outcome()
  def decide_inline(args) when is_map(args) do
    with {:ok, region} <- require_str(args, :region),
         {:ok, question} <- require_str(args, :question),
         {:ok, store} <- require_store(args) do
      # 1. SEAL: the frontier of the FOLDED set — the max seq among the records the
      #    fold actually materializes (:finding). Fixed BEFORE the fold so the set
      #    is stable (P1.2). The watermark MUST track exactly project_findings/3's
      #    set: if it advanced on records the fold ignores (a claim/goal/intention,
      #    or a verdict's own seq bump), a re-decide over an UNCHANGED finding set
      #    would seal higher -> a different id -> a spurious second verdict over the
      #    same findings (idempotency break, DC-8).
      watermark = finding_frontier(store, region)

      # 2. The idempotent verdict id over the sealed frontier.
      id = verdict_id(region, question, watermark)

      # 3. Idempotency: a verdict with this id already committed -> no-op collapse.
      case existing_verdict(store, region, id) do
        {:ok, payload} ->
          {:verdict, id, payload}

        :none ->
          commit(store, region, question, watermark, id, args)
      end
    else
      {:error, _} = err -> err
    end
  end

  # 4. Fold the sealed findings (userland PTC over a materialized projection), then
  #    write the verdict record. Single-node: a direct local fold + write (no Ra).
  defp commit(store, region, question, watermark, id, args) do
    findings = project_findings(store, region, watermark)

    case run_fold(args[:fold] || args["fold"], findings) do
      {:ok, fold_result} ->
        payload =
          %{
            "verdict_id" => id,
            "question" => question,
            "watermark" => watermark,
            "result" => fold_result,
            "findings_count" => length(findings)
          }

        terminal = truthy(args[:terminal] || args["terminal"])
        author = str_or_nil(args[:author] || args["author"])

        rec =
          Record.new(:verdict, region, payload,
            author: author,
            watermark: watermark,
            sealed: terminal
          )

        case Store.put(store, rec) do
          {:ok, _stored} -> {:verdict, id, payload}
          {:error, :sealed} -> already_sealed(store, region, id)
        end

      {:error, reason} ->
        {:error, {:fold_failed, reason}}
    end
  end

  # If the region sealed between our frontier read and our put (a terminal verdict
  # landed first), surface that verdict if it is ours, else report the seal.
  defp already_sealed(store, region, id) do
    case existing_verdict(store, region, id) do
      {:ok, payload} -> {:verdict, id, payload}
      :none -> {:error, :sealed}
    end
  end

  # The seal frontier = the max seq among the FOLDED records (:finding), which is
  # EXACTLY the set project_findings/3 materializes. Keeping these two in lockstep
  # is the idempotency invariant: a re-decide whose finding set is unchanged seals
  # at the same watermark -> the same id, regardless of any claim/goal/intention/
  # verdict written in between (those advance the raw region seq but not this
  # frontier). When the fold boundary widens to more kinds, widen this to match.
  defp finding_frontier(store, region) do
    store
    |> Store.by_kind(region, :finding)
    |> Enum.map(& &1.seq)
    |> Enum.max(fn -> 0 end)
  end

  # ---- the materialize boundary (Lens.project_node analogue) ----

  @doc """
  Project a region's `:finding` records WHERE `seq <= watermark` into string-keyed,
  JSON-safe maps for the fold sandbox. The sealed, totally-ordered set — no
  `%Record{}` struct, tuple, or pid crosses into PTC (the frozen-data contract).
  """
  @spec project_findings(module(), String.t(), non_neg_integer()) :: [map()]
  def project_findings(store, region, watermark) do
    store
    |> Store.by_kind(region, :finding)
    |> Enum.filter(fn r -> is_integer(r.seq) and r.seq <= watermark end)
    |> Enum.sort_by(& &1.seq)
    |> Enum.map(&project_finding/1)
  end

  defp project_finding(%Record{} = r) do
    %{
      "seq" => r.seq,
      "author" => r.author,
      "payload" => jsonable(r.payload),
      "t" => r.t
    }
  end

  # ---- the fold (userland PTC) ----

  # No fold source -> the default: return the findings + their count (the verdict
  # records what it saw). A binary source -> run it in the sandbox over
  # data/findings, exactly like Hist.Lens.run.
  defp run_fold(nil, findings), do: {:ok, %{"findings" => findings, "count" => length(findings)}}

  defp run_fold(source, findings) when is_binary(source) do
    context = %{"findings" => findings}

    case PtcRunner.Lisp.run(source,
           context: context,
           filter_context: false,
           caller: :in_process_v1
         ) do
      {:ok, step} -> {:ok, jsonable(step.return)}
      {:error, step} -> {:error, step.fail || step.return || :fold_error}
    end
  rescue
    e -> {:error, Exception.message(e)}
  catch
    :exit, reason -> {:error, {:fold_exit, reason}}
  end

  # A non-nil, non-binary :fold is MALFORMED — error like a bad PTC program rather
  # than silently committing the default (a malformed fold must never decide).
  defp run_fold(other, _findings), do: {:error, {:fold_invalid, other}}

  # ---- idempotency lookup ----

  # A verdict for this id already in the region (re-decide at the same watermark)?
  defp existing_verdict(store, region, id) do
    store
    |> Store.by_kind(region, :verdict)
    |> Enum.find(fn r -> verdict_id_of(r) == id end)
    |> case do
      nil -> :none
      %Record{payload: payload} -> {:ok, jsonable(payload)}
    end
  end

  defp verdict_id_of(%Record{payload: payload}) when is_map(payload) do
    Map.get(payload, "verdict_id") || Map.get(payload, :verdict_id)
  end

  # ---- the idempotent id ----

  @doc """
  The verdict id = `hash(region <> question <> watermark)`. Deterministic over the
  sealed frontier, so a re-elected leader (or a re-decide) commits the SAME id.
  """
  @spec verdict_id(String.t(), String.t(), non_neg_integer()) :: String.t()
  def verdict_id(region, question, watermark) do
    bin = [region, "\n", question, "\n", Integer.to_string(watermark)]
    :crypto.hash(:sha256, bin) |> Base.encode16(case: :lower) |> binary_part(0, 24)
  end

  # ---- helpers ----

  defp require_str(args, key) do
    case fetch(args, key) do
      s when is_binary(s) and s != "" -> {:ok, s}
      other -> {:error, {:invalid, key, other}}
    end
  end

  defp require_store(args) do
    case args[:store] || args["store"] do
      mod when is_atom(mod) and not is_nil(mod) -> {:ok, mod}
      other -> {:error, {:invalid, :store, other}}
    end
  end

  defp fetch(args, key) when is_atom(key) do
    args[key] || args[Atom.to_string(key)]
  end

  defp str_or_nil(s) when is_binary(s), do: s
  defp str_or_nil(_), do: nil

  defp truthy(true), do: true
  defp truthy("true"), do: true
  defp truthy(_), do: false

  # Best-effort coercion to JSON/PTC-safe data (tuples -> lists), mirroring
  # Hist.Lens.jsonable so the verdict payload + folded findings stay serializable.
  defp jsonable(term) when is_tuple(term), do: term |> Tuple.to_list() |> Enum.map(&jsonable/1)
  defp jsonable(term) when is_list(term), do: Enum.map(term, &jsonable/1)

  defp jsonable(term) when is_map(term),
    do: Map.new(term, fn {k, v} -> {jsonable(k), jsonable(v)} end)

  defp jsonable(term) when is_atom(term) and term not in [true, false, nil],
    do: Atom.to_string(term)

  defp jsonable(term), do: term
end
