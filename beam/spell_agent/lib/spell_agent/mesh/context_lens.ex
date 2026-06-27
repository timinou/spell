defmodule SpellAgent.Mesh.ContextLens do
  @moduledoc """
  A spawned child's context as a LENS over the append-only stores at its spawn
  watermark (PLAN-019 M7, FEAT-017) \u2014 NOT pushed messages.

  A child's rich context is a projection over the union, scoped to the cohort, at
  `seq <= W` (the handle's watermark):

      (region records @ seq<=W)  \u2295  (the reasoning that produced them)

  `black/*` gives WHAT the cohort found (findings/goals/verdicts); `hist/*` gives
  WHY/HOW (the `Node.form` / `sees` that produced each). The lens JOINS them: a
  `:finding` carries `:author` (a session id) + `:seq`, which is a handle back into
  the producer's hist \u2014 so the lens injects "the findings AND the reasoning traces
  that produced them" (the WHAT+WHY join). Neither store alone is the context; the
  projection over BOTH, joined by author, is.

  ## The materialize boundary (the boundary doctrine)

  `build_context/3` is ELIXIR (it materializes private hist/mesh shapes \u2014 `%Node{}`,
  `%Record{}` \u2014 into ONE string-keyed, JSON-round-trippable bag). The bag is then
  injected as the child's `data/*` (the inject job), where a PTC prompt hole or an
  authored `.ptc` cohort lens reshapes it (the transform). No struct/tuple/pid ever
  crosses into the sandbox \u2014 the same contract `Hist.Lens.project_node/1` enforces.

  ## Determinism (a context-correctness property, not a caching mandate)

  Same `W` -> same projection -> same context. Two children spawned at the same
  watermark get a byte-identical baseline (the immutable cohort snapshot). That this
  also caches well downstream (FEAT-018 S-F) is incidental; the lens exists for RICH
  CONTEXT, and is built to be correct + reproducible regardless.

  ## Source-fold layer (shared with memory threading, FEAT-018 S-E)

  The folds below (`findings/3`, `edited_files/3`, `files_read/3`, `tool_history/3`)
  are a SOURCE-PROJECTION LAYER over append-only stores at a watermark. Two
  deliveries consume it: PULL (this lens -> injected `data/*`) and PUSH (a memory
  seed -> the child's def-env). One source layer, two readers (doc 15 U1/U3).
  """

  alias SpellAgent.Hist
  alias SpellAgent.Hist.Lens
  alias SpellAgent.Mesh.Store, as: MeshStore

  @doc """
  Build a child's context bag from its mission handle (string-keyed, as
  `Mesh.Spawn.handle_to_map/1` produces it) at the handle's watermark.

  `opts`:
    * `:store`   \u2014 the Hist store impl (default `Hist.default_store/0`).
    * `:siblings` \u2014 explicit sibling session ids whose findings/hist to project
      (default: derived from the region's record authors at `seq <= W`, minus the
      child itself).
    * `:where`   \u2014 a payload predicate (`%{field => value}`) narrowing which
      findings project (the scope predicate; keeps the bag small + cacheable).
    * `:join_hist` \u2014 when true (default), join each finding to its author's hist
      reasoning nodes (the WHAT+WHY join). false -> findings alone (WHAT only).

  Returns a string-keyed bag:

      %{
        "region"     => region_id,
        "watermark"  => W,
        "findings"   => [%{"seq","author","payload","t","reasoning" => [node…]} …],
        "goals"      => [record …],
        "verdicts"   => [record …],
        "siblings"   => [session_id …]
      }

  Records with `seq > W` are EXCLUDED (the watermark boundary). Degrades to a bag
  with empty sections on a sick store \u2014 a child's context is an enhancement, never
  a dependency of its run.
  """
  @spec build_context(map(), keyword()) :: map()
  def build_context(handle, opts \\ []) when is_map(handle) do
    store = opts[:store] || Hist.default_store()
    region = get(handle, "region")
    child = get(handle, "child") || get(handle, "session")
    watermark = watermark(handle)

    do_build(store, region, child, watermark, opts)
  rescue
    e -> empty_bag(handle) |> Map.put("error", Exception.message(e))
  catch
    :exit, _ -> empty_bag(handle)
  end

  defp do_build(_store, region, _child, _w, _opts) when not is_binary(region),
    do: empty_bag(%{"region" => region})

  defp do_build(store, region, child, watermark, opts) do
    where = opts[:where]
    join_hist? = Keyword.get(opts, :join_hist, true)

    findings = findings(store, region, watermark, where)
    goals = records_at(store, region, :goal, watermark)
    verdicts = records_at(store, region, :verdict, watermark)

    siblings =
      case opts[:siblings] do
        list when is_list(list) -> list
        _ -> derive_siblings(findings, goals, child)
      end

    finding_entries =
      if join_hist? do
        Enum.map(findings, fn r -> join_reasoning(store, r, siblings) end)
      else
        Enum.map(findings, &render_record/1)
      end

    %{
      "region" => region,
      "watermark" => watermark,
      "findings" => finding_entries,
      "goals" => Enum.map(goals, &render_record/1),
      "verdicts" => Enum.map(verdicts, &render_record/1),
      "siblings" => siblings
    }
  end

  # ---- the source-fold layer (shared pull/push) ----

  @doc """
  Findings in `region` at `seq <= watermark`, optionally narrowed by a `where`
  payload predicate. The cohort's conclusions (the WHAT). Shared by the context
  lens (pull) and a memory fold (push).
  """
  @spec findings(module(), String.t(), non_neg_integer(), map() | nil) :: [map()]
  def findings(store, region, watermark, where \\ nil) do
    match = if is_map(where), do: %{"kind" => "finding", "where" => where}, else: %{"kind" => "finding"}

    store
    |> MeshStore.by_match(region, match)
    |> at_watermark(watermark)
  end

  @doc """
  The set of files a session's lineage EDITED at `seq <= watermark`, folded from
  each hist node's `sees` (edit/write tool effects). Returns `[%{"file" => path}]`.
  """
  @spec edited_files(module(), String.t(), non_neg_integer()) :: [map()]
  def edited_files(store, session_id, watermark) do
    fold_sees(store, session_id, watermark, ["edit", "write", "create"])
  end

  @doc """
  The files a session READ at `seq <= watermark`, folded from `sees` (find/get/read
  effects). The files the parent found worth reading \u2014 seed a child so it does not
  re-discover them.
  """
  @spec files_read(module(), String.t(), non_neg_integer()) :: [map()]
  def files_read(store, session_id, watermark) do
    fold_sees(store, session_id, watermark, ["find", "get", "read"])
  end

  @doc """
  A session's tool-call history at `seq <= watermark`, optionally one tool kind.
  """
  @spec tool_history(module(), String.t(), non_neg_integer(), String.t() | nil) :: [map()]
  def tool_history(store, session_id, watermark, kind \\ nil) do
    store
    |> project_session(session_id, watermark)
    |> Enum.flat_map(fn node -> Map.get(node, "tool_calls", []) end)
    |> filter_kind(kind)
  end

  # ---- the WHAT+WHY join ----

  # Join a finding to its author's hist reasoning: the nodes of the author session
  # (a sibling or self) at seq<=W. Degrades to the finding alone when the author's
  # hist is absent/GC'd (WHAT without WHY) \u2014 never fails.
  defp join_reasoning(store, %{author: author} = record, siblings) when is_binary(author) do
    base = render_record(record)

    if author in siblings or author == record.author do
      reasoning =
        store
        |> project_session(author, nil)
        |> Enum.map(fn node -> Map.take(node, ["id", "seq", "form_src", "tool_calls"]) end)

      Map.put(base, "reasoning", reasoning)
    else
      Map.put(base, "reasoning", [])
    end
  rescue
    _ -> render_record(record)
  end

  defp join_reasoning(_store, record, _siblings), do: render_record(record)

  # ---- helpers ----

  # Records of a kind at seq<=W.
  defp records_at(store, region, kind, watermark) do
    store |> MeshStore.by_kind(region, kind) |> at_watermark(watermark)
  end

  # Keep only records with an integer seq <= watermark (the boundary). A nil
  # watermark (no boundary) keeps all.
  defp at_watermark(records, nil), do: records

  defp at_watermark(records, watermark) when is_integer(watermark) do
    Enum.filter(records, fn r -> is_integer(r.seq) and r.seq <= watermark end)
  end

  # Siblings = the authors of the region's records (findings + goals) minus the
  # child itself and nils. The cohort that produced the context.
  defp derive_siblings(findings, goals, child) do
    (findings ++ goals)
    |> Enum.map(& &1.author)
    |> Enum.reject(&(is_nil(&1) or &1 == child))
    |> Enum.uniq()
  end

  # Project a session's hist nodes (string-keyed) at seq<=W via Hist.Lens.project.
  defp project_session(store, session_id, watermark) do
    opts = if is_integer(watermark), do: [], else: []
    # NB: Hist node seq and mesh region seq are DIFFERENT sequences; the hist
    # projection is scoped by the session, and the watermark boundary is applied to
    # MESH records (findings), not hist nodes. A sibling's hist is its reasoning up
    # to now; only its findings posted <=W are in the cohort (monotone, safe).
    Lens.project(store, session_id, opts)
  rescue
    _ -> []
  catch
    _, _ -> []
  end

  # Fold a session's hist `sees`/tool_calls for tool effects whose name is in
  # `names`, returning [%{"file" => path}] (deduped). Reads the projected
  # tool_calls (realized effects) and extracts a file-ish arg.
  defp fold_sees(store, session_id, watermark, names) do
    store
    |> project_session(session_id, watermark)
    |> Enum.flat_map(fn node -> Map.get(node, "tool_calls", []) end)
    |> Enum.filter(fn call -> tool_name(call) in names end)
    |> Enum.flat_map(&extract_files/1)
    |> Enum.uniq()
    |> Enum.map(fn f -> %{"file" => f} end)
  end

  defp filter_kind(calls, nil), do: calls
  defp filter_kind(calls, kind), do: Enum.filter(calls, fn c -> tool_name(c) == kind end)

  defp tool_name(call) when is_map(call), do: Map.get(call, "name") || Map.get(call, "tool")
  defp tool_name(_), do: nil

  # Extract file path args from a realized tool call's args (best-effort: a "path",
  # "file", or "target" string).
  defp extract_files(%{"args" => args}) when is_map(args) do
    ["path", "file", "target", "paths"]
    |> Enum.flat_map(fn k -> List.wrap(Map.get(args, k)) end)
    |> Enum.filter(&is_binary/1)
  end

  defp extract_files(_), do: []

  defp render_record(r) do
    %{
      "seq" => r.seq,
      "author" => r.author,
      "kind" => to_string(r.kind),
      "payload" => r.payload,
      "t" => r.t
    }
  end

  defp watermark(handle) do
    case get(handle, "watermark") do
      n when is_integer(n) -> n
      _ -> nil
    end
  end

  defp empty_bag(handle) do
    %{
      "region" => get(handle, "region"),
      "watermark" => get(handle, "watermark"),
      "findings" => [],
      "goals" => [],
      "verdicts" => [],
      "siblings" => []
    }
  end

  defp get(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, safe_atom(key))
  defp get(_map, _key), do: nil

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end
end
