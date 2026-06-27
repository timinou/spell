defmodule SpellAgent.Mesh.Namespace do
  @moduledoc """
  The `black/*` PTC-Lisp verb surface (PROJ-006, FEAT-010) — the cross-session
  generalization of the self-scoped `hist/*` verbs (`SpellAgent.Hist.Namespace`).

  `tools/3` returns a `%{"black/post" => fn args -> ... end, ...}` map whose
  closures capture the store `impl`, the calling `session_id`, and the `region`
  this session is coordinating in — exactly the shape `Hist.Namespace.tools/2`
  uses. The map is merged into the agent's tools in `SpellAgent.Session.run/2`.

  ## The four monotone verbs (FEAT-010 scope)

    * `black/post`  — append a monotone record (goal | finding | intention).
    * `black/query` — content-addressed discovery; an ambient read.
    * `black/claim` — optimistic claim; append + resolve-by-fold (seq, author).
    * `black/fold`  — a pure read-time reduce (count | group-by | rank | predicate).

  `black/watch` fires a condition-fused self-wake via the single-node
  `Mesh.Watcher` (A3, FEAT-021). `black/decide` seals + folds + commits an
  idempotent `:verdict` via `Mesh.Consensus` (FEAT-012, single-node path; the
  multi-node Ra election is FUP-020).

  ## Corrections baked in (oracle MeshFinalCheck)

    * ordering is the STORE's per-region `seq`, never a per-session Lamport clock
      (P2.1/P2.3) — claim arbitration folds `argmin(seq, author)`.
    * `:won?` is PROVISIONAL — authoritative single-node, best-effort multi-node;
      callers route irreversible work through `decide`, expensive work uses
      `:settle_ms` (P2.3).
    * Fork-A re-goal is accepted only from the recorded owner while that owner is
      live (`SessionRegistry.live?/1`) — else it must go through `decide` (P1.3).

  Best-effort posture: a store error inside a verb is returned as `%{"err" => _}`
  (like `Hist.Namespace.normalize_err`), never crashing the agent turn.
  """

  alias SpellAgent.Mesh.{Consensus, Record, Region, Store}
  alias SpellAgent.SessionRegistry

  @doc """
  The `black/*` tool map for a `session_id` coordinating in `region`, over store
  `impl`. `held` is the session's write-capability set (the region ids it may
  write); defaults to `[region]` (it holds the region it was handed).
  """
  @spec tools(module(), String.t(), String.t(), keyword()) ::
          %{optional(String.t()) => (map() -> term())}
  def tools(impl, session_id, region, opts \\ []) do
    held = opts[:held] || [region]

    %{
      "black/post" => fn args -> guard(fn -> post(impl, session_id, region, held, args) end) end,
      "black/query" => fn args -> guard(fn -> query(impl, region, args) end) end,
      "black/claim" => fn args -> guard(fn -> claim(impl, session_id, region, held, args) end) end,
      "black/fold" => fn args -> guard(fn -> fold(impl, region, args) end) end,
      "black/watch" => fn args -> guard(fn -> watch(impl, session_id, region, held, args) end) end,
      "black/decide" => fn args -> guard(fn -> decide(impl, session_id, region, held, args) end) end
    }
  end

  # --- black/post ---

  defp post(impl, session_id, region, held, args) do
    kind = args |> get(["kind"]) |> to_kind()
    payload = get(args, ["payload"]) || %{}

    cond do
      kind not in [:goal, :finding, :intention] ->
        %{
          "err" =>
            "black/post kind must be :goal, :finding, or :intention (got #{inspect(kind)}); " <>
              "claims go through black/claim, verdicts through black/decide"
        }

      not Region.write_cap?(region, held) ->
        %{"err" => "no write capability for region #{inspect(region)}"}

      kind == :goal and not goal_ok?(impl, session_id, region) ->
        %{
          "err" =>
            "re-goaling rejected: only the live region owner may supersede the goal; " <>
              "promote to Fork-B and use black/decide to re-goal a parentless region"
        }

      true ->
        rec = Record.new(kind, region, stringify(payload), author: session_id)

        case Store.put(impl, rec) do
          {:ok, stored} -> %{"id" => stored.seq, "region" => region, "kind" => to_string(kind)}
          {:error, :sealed} -> %{"err" => "region #{inspect(region)} is sealed; no further posts"}
        end
    end
  end

  # First goal is a free create; a subsequent goal (re-goal) is owner+liveness gated.
  defp goal_ok?(impl, session_id, region) do
    case Store.by_kind(impl, region, :goal) do
      [] ->
        true

      goals ->
        owner = goals |> Enum.min_by(& &1.seq) |> Map.get(:author)
        owner == session_id and owner != nil and SessionRegistry.live?(owner)
    end
  end

  # --- black/watch (A3, FEAT-021) ---

  # Register a standing trigger as a durable, claimable :intention record: "when a
  # record matching :when is posted to :region, schedule a Clock wake from :wake."
  # Registering is a pure monotone post (CALM-clean); the single-node Mesh.Watcher
  # observes posts and fires via Clock. A watch with no watcher still persists and
  # fires whenever a watcher next runs (best-effort, F.2).
  defp watch(impl, session_id, region, held, args) do
    when_pred = get(args, ["when"])
    wake = get(args, ["wake"])
    target = get(args, ["region"]) || region

    cond do
      not Region.write_cap?(target, held) ->
        %{"err" => "no write capability for region #{inspect(target)}"}

      not valid_when?(when_pred) ->
        %{
          "err" =>
            "black/watch requires :when as %{:kind k :where {...}} or %{:kind k :count N}"
        }

      not valid_wake?(wake) ->
        %{"err" => "black/watch requires :wake with a non-empty :prompt"}

      true ->
        payload =
          %{
            "when" => stringify(when_pred),
            "wake" => normalize_wake(wake, session_id),
            "once" => once_flag(args),
            "registered_at" => System.system_time(:millisecond)
          }
          |> put_if("ttl_ms", ttl_ms(args))
          |> put_if("fuel", fuel(args))

        case Store.put(impl, Record.new(:intention, target, payload, author: session_id)) do
          {:ok, stored} ->
            %{"id" => stored.seq, "region" => target, "watching" => payload["when"]}

          {:error, :sealed} ->
            %{"err" => "region #{inspect(target)} is sealed; no further posts"}
        end
    end
  end

  # A :when predicate is the where-form (%{kind, where}) or the threshold form
  # (%{kind, count}); kind is optional in both (nil kind = match any kind).
  defp valid_when?(w) when is_map(w) do
    has_where = is_map(get(w, ["where"]))
    has_count = is_integer(get(w, ["count"]))
    has_kind = not is_nil(get(w, ["kind"]))
    has_where or has_count or has_kind
  end

  defp valid_when?(_), do: false

  defp valid_wake?(w) when is_map(w) do
    case get(w, ["prompt"]) do
      p when is_binary(p) and p != "" -> true
      _ -> false
    end
  end

  defp valid_wake?(_), do: false

  # The wake payload handed to Clock on fire: prompt (+ optional budget), with
  # session_id defaulting to the registering session so the wake continues THIS
  # conversation unless the agent targets another.
  defp normalize_wake(wake, session_id) do
    base = %{"prompt" => get(wake, ["prompt"]), "session_id" => get(wake, ["session_id"]) || session_id}
    case get(wake, ["budget"]) do
      b when is_map(b) -> Map.put(base, "budget", stringify(b))
      _ -> base
    end
  end

  # :once defaults TRUE (retire after first fire); explicit false re-fires.
  defp once_flag(args) do
    case get(args, ["once"]) do
      false -> false
      _ -> true
    end
  end

  defp ttl_ms(args) do
    case get(args, ["ttl_ms"]) do
      n when is_integer(n) and n > 0 -> n
      _ -> nil
    end
  end

  # :fuel = the max number of times this watch may fire before retiring (FEAT-013).
  # Bounds a self-retriggering cascade. Absent -> the Watcher defaults from :once.
  defp fuel(args) do
    case get(args, ["fuel"]) do
      n when is_integer(n) and n > 0 -> n
      _ -> nil
    end
  end

  # --- black/query ---

  defp query(impl, region, args) do
    match = get(args, ["match"]) || %{}
    target = get(args, ["region"]) || region

    impl
    |> Store.by_match(target, normalize_match(match))
    |> Enum.reverse()
    |> Enum.map(&render(&1))
  end

  # --- black/claim ---

  defp claim(impl, session_id, region, held, args) do
    work = get(args, ["work"])
    lease_ms = get(args, ["lease_ms"])
    settle_ms = get(args, ["settle_ms"])

    cond do
      is_nil(work) ->
        %{"err" => "black/claim requires :work"}

      not Region.write_cap?(region, held) ->
        %{"err" => "no write capability for region #{inspect(region)}"}

      true ->
        payload = %{"work" => work, "claimed_at" => System.system_time(:millisecond)}
        payload = if lease_ms, do: Map.put(payload, "lease_ms", lease_ms), else: payload

        case Store.put(impl, Record.new(:claim, region, payload, author: session_id)) do
          {:ok, mine} ->
            if is_integer(settle_ms) and settle_ms > 0, do: Process.sleep(settle_ms)
            resolve_claim(impl, region, work, session_id, mine.seq)

          {:error, :sealed} ->
            %{"err" => "region #{inspect(region)} is sealed"}
        end
    end
  end

  # Winner = argmin(seq, author) over non-expired claims for the work id.
  defp resolve_claim(impl, region, work, session_id, my_seq) do
    now = System.system_time(:millisecond)

    winner =
      impl
      |> Store.claims_for(region, work)
      |> Enum.reject(&expired?(&1, now))
      |> Enum.min_by(fn c -> {c.seq, c.author || ""} end, fn -> nil end)

    owner = if winner, do: winner.author, else: session_id

    %{
      "claim" => my_seq,
      "won?" => winner != nil and winner.author == session_id,
      "owner" => owner,
      "provisional" => true
    }
  end

  defp expired?(%Record{payload: p, t: t}, now) do
    case fetch(p, "lease_ms") do
      ms when is_integer(ms) and ms > 0 -> now > t + ms
      _ -> false
    end
  end

  # --- black/decide (FEAT-012, Mesh.Consensus) ---

  # Seal the region frontier, fold the sealed findings (optionally via an
  # agent-authored PTC :fold over data/findings), and commit an idempotent
  # :verdict. Single-node degenerates to a local seal+fold+write (no Ra).
  defp decide(impl, session_id, region, held, args) do
    cond do
      not Region.write_cap?(region, held) ->
        %{"err" => "no write capability for region #{inspect(region)}"}

      not is_binary(get(args, ["question"])) or get(args, ["question"]) == "" ->
        %{"err" => "black/decide requires a non-empty :question"}

      true ->
        decide_args = %{
          region: region,
          question: get(args, ["question"]),
          fold: get(args, ["fold"]),
          terminal: get(args, ["terminal"]) || false,
          store: impl,
          author: session_id
        }

        # NB: the single-node path returns {:verdict, _} | {:error, _}. The
        # {:pending, _} outcome (sub-quorum) only arises on the multi-node Ra
        # path (FUP-020); it is handled there when that path lands.
        case Consensus.decide(decide_args) do
          {:verdict, id, payload} ->
            %{"verdict" => id, "region" => region, "payload" => payload}

          {:error, reason} ->
            %{"err" => "black/decide failed: #{inspect(reason)}"}
        end
    end
  end

  # --- black/fold ---

  defp fold(impl, region, args) do
    over = args |> get(["over"]) |> to_kind()
    reduce = get(args, ["reduce"])
    recs = if over, do: Store.by_kind(impl, region, over), else: Store.region(impl, region)

    case to_reduce(reduce) do
      :count ->
        length(recs)

      :"group-by" ->
        field = get(args, ["field"])

        recs
        |> Enum.group_by(fn r -> fetch(r.payload, to_string(field)) end)
        |> Enum.map(fn {k, v} -> {k, Enum.map(v, &render/1)} end)
        |> Map.new()

      :rank ->
        field = get(args, ["field"])

        recs
        |> Enum.sort_by(fn r -> fetch(r.payload, to_string(field)) end)
        |> Enum.map(&render/1)

      :"goal-satisfied?" ->
        goal_satisfied?(impl, region)

      _ ->
        %{"err" => "black/fold :reduce must be :count, :group-by, :rank, or :goal-satisfied?"}
    end
  end

  # A goal is "satisfied" when at least one finding exists per the goal's declared
  # success criterion's count, if any; else simply when any finding exists. Kept
  # deliberately simple in v1 (the fold is pure; richer predicates are agent-authored).
  defp goal_satisfied?(impl, region) do
    findings = Store.by_kind(impl, region, :finding)
    findings != []
  end

  # --- rendering + helpers ---

  defp render(%Record{} = r) do
    %{
      "seq" => r.seq,
      "kind" => to_string(r.kind),
      "author" => r.author,
      "payload" => r.payload,
      "t" => r.t
    }
  end

  defp normalize_match(match) when is_map(match) do
    match
    |> stringify()
    |> then(fn m ->
      %{}
      |> put_if(:kind, m["kind"])
      |> put_if(:where, m["where"])
    end)
  end

  defp put_if(map, _k, nil), do: map
  defp put_if(map, k, v), do: Map.put(map, k, v)


  # Run a verb body, converting any raise/exit into a best-effort {"err" ...} so a
  # sick store never crashes the agent turn (mirrors Hist.Namespace posture).
  defp guard(fun) do
    fun.()
  rescue
    e -> %{"err" => Exception.message(e)}
  catch
    :exit, reason -> %{"err" => "mesh verb exit: #{inspect(reason)}"}
  end

  # arg access tolerant of string OR atom keys (LispKeyword), like Tools.flex_get.
  defp get(args, [key]) when is_map(args), do: fetch(args, key)

  defp fetch(map, key) when is_map(map) and is_binary(key) do
    case Map.fetch(map, key) do
      {:ok, v} -> v
      :error -> Map.get(map, safe_atom(key))
    end
  end

  defp fetch(_map, _key), do: nil

  defp to_kind(nil), do: nil
  defp to_kind(k) when is_atom(k), do: k
  defp to_kind(k) when is_binary(k), do: safe_atom(k)

  defp to_reduce(nil), do: nil
  defp to_reduce(r) when is_atom(r), do: r
  defp to_reduce(r) when is_binary(r), do: safe_atom(r)

  defp stringify(map) when is_map(map), do: Map.new(map, fn {k, v} -> {to_string(k), v} end)
  defp stringify(other), do: other

  defp safe_atom(k) when is_binary(k) do
    String.to_existing_atom(k)
  rescue
    ArgumentError -> nil
  end
end
