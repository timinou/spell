defmodule SpellAgent.Hist.Reduce do
  @moduledoc """
  The lossless reduction fold over the node DAG (PLAN-018 W4).

  A reduction is a pure `[Node.t()] -> [Node.t()]` transform in node-space, which
  the W3 `Refold` then projects to a replayable tape. This module ships the
  LOSSLESS tier: transforms that provably preserve both the reconstructed def-env
  and the error-recovery evidence, so they are safe to apply silently.

  ## The lossless contract (the proof that defines the tier)

  `fold_env/1` reconstructs the def-env by merging each node's `binds` delta in
  seq order (the same single fold semantics `Node.apply_binds/2` and
  `Reconstitute.fold_env` share). The tier's defining invariant:

      fold_env(reduce(slice)) == fold_env(slice)

  Every transform below is designed to keep that equality. Three of the four never
  touch `binds` at all (they shrink `sees` / `prints` payload, which the env fold
  does not read); the fourth, dead-bind-elim, drops only a bind that a later node
  OVERWRITES before any intervening read, so the merge result is unchanged.

  ## The transforms

    * `dead-bind-elim` — a binding `x` introduced by node A and REBOUND by a later
      node B is dead in A IFF no node in the open interval (A, B] READS `x` (a
      `{:var, "x"}` anywhere in its form). The fold's last-write-wins merge already
      discards A's value, so dropping it from A's `binds` is invisible to the
      env. (Compiler dead-store elimination, on the def-env.)

    * `tool-cse` — two `sees` entries that are IDENTICAL in name, args, AND result
      (the exact-duplicate test; an idempotent read run twice) collapse: the first
      is kept verbatim, later copies keep the call record but drop the duplicated
      result payload, carrying a `"cse_ref"` to the keeper. `sees` is not read by
      the env fold, so this is env-neutral by construction.

    * `stale-read-collapse` — repeated OK reads of the same (name, args) where only
      the LAST feeds current state: earlier copies drop their result payload,
      keeping a `"stale"` marker. Errors are EXEMPT (a failed call's evidence is
      never dropped — error recovery needs it).

    * `print-prune` — `prints` are display output no later form references; they
      are dropped from the reduced node (the original stays in the store). Env-
      neutral (prints are not binds).

  ## Errors are exempt (the recovery invariant)

  No transform ever drops a FAILED tool call or its result: `tool-cse` and
  `stale-read-collapse` only group OK-status calls (`Hist.Result.status/1`), and
  dead-bind-elim touches `binds`, not `sees`. A failure stays in the tape so the
  model can still see what went wrong on replay.

  ## Why Elixir, not a .ptc policy (boundary note)

  The matchers here are structural (the same shape `q/match` expresses), but the
  load-bearing property is env-RECOVERABILITY — a `binds`-level invariant proven
  by `fold_env`, which is a mechanism concern ("Elixir owns invariants"). The
  reduction POLICY (which transforms, in what order, at what aggressiveness) is
  the part destined to migrate to editable `.ptc` data; the env-proof stays here.
  W4 ships the mechanism + the lossless transforms; the policy-as-data refinement
  is a follow-up.
  """

  alias SpellAgent.Hist.{Effect, Node, Result, Spill}

  @doc """
  Reduce a node slice (root-first) with the lossless tier.

  Pure over its input — no store reads — so a caller folds a projected slice
  without touching the DAG. Returns the reduced `[Node.t()]` in the same order.
  """
  @spec lossless([Node.t()]) :: [Node.t()]
  def lossless(slice) when is_list(slice) do
    slice
    |> dead_bind_elim()
    # stale-read BEFORE tool-cse: stale-collapse picks the TRUE last read of a
    # path (over raw reads) and drops the superseded earlier payloads; tool-cse
    # then dedups whatever identical results remain. Running cse first could turn
    # the genuine last read into a cse_ref to an earlier node whose payload
    # stale-collapse then drops, making the last result unrecoverable (S4 swarm
    # finding). This order keeps each transform's keeper intact.
    |> stale_read_collapse()
    |> tool_cse()
    |> print_prune()
  end

  @doc """
  Reconstruct the def-env from a node slice by folding `binds` in order.

  The proof oracle for the lossless tier: `fold_env(lossless(slice)) ==
  fold_env(slice)`. Mirrors `Reconstitute.fold_env` / `Node.apply_binds` exactly,
  but pure over an explicit slice (no snapshot, no store) so a test can assert the
  equality directly.
  """
  @spec fold_env([Node.t()]) :: map()
  def fold_env(slice) when is_list(slice) do
    Enum.reduce(slice, %{}, fn %Node{binds: binds}, env -> Node.apply_binds(env, binds) end)
  end

  @doc """
  Reduce a node slice with the LOSSY-but-restorable tier (PLAN-018 W6).

  Runs the full lossless tier, then `Spill.spill/2` to rewrite over-threshold,
  RESTORABLE `node.result`s into re-fetchable stubs — the transform that actually
  sheds TAPE bytes (the lossless tier shrinks only the node store; see the L1
  finding). The env proof still holds: spill touches `result`, never `binds`, so
  `fold_env(lossy(slice)) == fold_env(slice)`. Restorability is the contract — a
  spilled result is recoverable from the untouched store node via `hist/recall`.

  Options forward to `Spill.spill/2` (e.g. `:threshold_tokens`).
  """
  @spec lossy([Node.t()], keyword()) :: [Node.t()]
  def lossy(slice, opts \\ []) when is_list(slice) do
    slice |> lossless() |> Spill.spill(opts)
  end

  # --- dead-bind-elim ---------------------------------------------------------

  # Drop, from each node's binds, every key that a LATER node rebinds with no
  # intervening read. Walk left-to-right tracking, for each key, the set of seqs
  # at which it is later rebound and read; a bind at node i is dead if some j > i
  # rebinds it and no k in (i, j] reads it.
  defp dead_bind_elim(slice) do
    indexed = Enum.with_index(slice)

    # For each index, the set of keys READ by that node's form.
    reads = Map.new(indexed, fn {n, i} -> {i, reads_of(n)} end)
    # For each index, the keys BOUND by that node.
    binds_at = Map.new(indexed, fn {n, i} -> {i, Map.keys(n.binds)} end)
    n = length(slice)

    Enum.map(indexed, fn {node, i} ->
      live =
        node.binds
        |> Enum.reject(fn {k, _v} -> dead_bind?(k, i, n, binds_at, reads) end)
        |> Map.new()

      %{node | binds: live}
    end)
  end

  # A bind of key `k` at index `i` is DEAD iff there exists a later index j that
  # rebinds `k` AND no index in (i, j] reads `k`. We take the NEAREST such j: if
  # the nearest rebind has an intervening read, `k` is live (a later rebind cannot
  # resurrect deadness across a read). Conservative: any read in the window keeps
  # the bind.
  defp dead_bind?(k, i, n, binds_at, reads) do
    case next_rebind(k, i, n, binds_at) do
      nil ->
        false

      j ->
        # read in the open-left, closed-right interval (i, j]? Bind keys may be
        # atoms (`%{plan: :final}`) while reads are collected as strings, so
        # compare on the normalized string name — a type mismatch here would miss
        # a real read and wrongly drop a LIVE bind (a lossless violation).
        ks = name_str(k)
        not Enum.any?((i + 1)..j, fn idx -> MapSet.member?(reads[idx], ks) end)
    end
  end

  defp next_rebind(_k, i, n, _binds_at) when i + 1 >= n, do: nil

  defp next_rebind(k, i, n, binds_at) do
    Enum.find((i + 1)..(n - 1), fn idx -> k in binds_at[idx] end)
  end

  # The set of variable names a node's form READS (every {:var, name} in the AST).
  defp reads_of(%Node{form: form}), do: form |> collect_vars([]) |> MapSet.new()

  defp collect_vars({:var, name}, acc), do: [name_str(name) | acc]

  defp collect_vars(form, acc) when is_tuple(form),
    do: form |> Tuple.to_list() |> Enum.reduce(acc, &collect_vars/2)

  defp collect_vars(form, acc) when is_list(form),
    do: Enum.reduce(form, acc, &collect_vars/2)

  defp collect_vars(form, acc) when is_map(form),
    do: Enum.reduce(form, acc, fn {_k, v}, a -> collect_vars(v, a) end)

  defp collect_vars(_form, acc), do: acc

  # --- tool-cse ---------------------------------------------------------------

  # Collapse exact-duplicate OK tool calls across the whole slice: the FIRST
  # occurrence of a (name, args, result) triple is kept; every later identical
  # copy keeps its call record but drops the duplicated result payload and gains a
  # "cse_ref" pointing at the keeper's node. Errors are never grouped.
  defp tool_cse(slice) do
    {reduced, _seen} =
      Enum.map_reduce(slice, %{}, fn %Node{sees: sees} = node, seen ->
        {new_sees, seen2} = cse_sees(sees, node.id, seen)
        {%{node | sees: new_sees}, seen2}
      end)

    reduced
  end

  defp cse_sees(sees, node_id, seen) when is_list(sees) do
    Enum.map_reduce(sees, seen, fn see, acc ->
      cond do
        # A stale-collapsed entry has already had its payload dropped — leave it
        # alone (it carries no result to CSE). Only un-reduced ok calls are
        # candidates for de-duplication.
        Map.has_key?(see, "stale") ->
          {see, acc}

        not ok_see?(see) ->
          {see, acc}

        true ->
          key = cse_key(see)

          case Map.get(acc, key) do
            nil ->
              {see, Map.put(acc, key, node_id)}

            keeper ->
              {see |> mixed_drop(:result) |> Map.put("cse_ref", keeper), acc}
          end
      end
    end)
  end

  defp cse_sees(sees, _node_id, seen), do: {sees, seen}

  # Exact-duplicate key: name + args + result. Differing results are NOT
  # duplicates (a call that returned something new is not redundant).
  defp cse_key(see) do
    {to_string(mixed_get(see, :name)), mixed_get(see, :args), mixed_get(see, :result)}
  end

  # --- stale-read-collapse ----------------------------------------------------

  # Within the slice, for OK reads sharing a (name, args) key, only the LAST keeps
  # its result; earlier copies drop the payload and gain a "stale" marker. This is
  # weaker than tool-cse (args match, result may differ) and models a path read
  # repeatedly where only the latest feeds current state.
  #
  # EFFECT-SOUNDNESS: collapsible ONLY for calls classified `:read` (idempotent +
  # restorable). A mutation/check/external call with the same args may have
  # returned a DIFFERENT, load-bearing result legitimately (two `date` calls, two
  # `mix test` runs), so collapsing them would drop real signal. The classifier is
  # conservative — anything not positively a read is left intact. Errors exempt; a
  # call already CSE-referenced is left alone.
  defp stale_read_collapse(slice) do
    # Flatten every see to a global ordinal so "between" is a simple comparison.
    flat = flatten_sees(slice)

    # WORLD-EPOCH BARRIER: a path's epoch is bumped by any WRITE (a non-read
    # effect — mutation/external/check/unknown — whose args touch that path). A
    # read may be staled only by a later read of the same key in the SAME epoch:
    # if a write to the path falls between them, both reads are load-bearing (read
    # v1, change, read v2), so the earlier MUST survive. We compute, per read key,
    # the set of write ordinals to its path, then stale a read only when a later
    # same-key read exists with no write ordinal strictly between them.
    write_ords = write_ordinals_by_path(flat)

    # group collapsible reads by key, in ordinal order.
    reads_by_key =
      flat
      |> Enum.filter(fn {_ord, _ni, _si, see} -> collapsible_read?(see) end)
      |> Enum.group_by(fn {_ord, _ni, _si, see} -> read_key(see) end)

    # the set of {ni, si} positions to stale: a read staled iff a LATER same-key
    # read shares its epoch (no write to the path strictly between the two).
    {writes_by_path, global_writes} = write_ords

    stale_pos =
      Enum.reduce(reads_by_key, MapSet.new(), fn {key, reads}, acc ->
        path = key_path(key)
        # a read's barrier = writes to ITS path, UNION the un-localizable global
        # writes (which touch everything). A nil-path read (unknown target) is
        # barriered by the global writes only — still conservative.
        path_writes = if path, do: Map.get(writes_by_path, path, []), else: []
        writes = Enum.sort(path_writes ++ global_writes)
        collect_stale(reads, writes, acc)
      end)

    slice
    |> Enum.with_index()
    |> Enum.map(fn {node, ni} ->
      new_sees =
        node.sees
        |> Enum.with_index()
        |> Enum.map(fn {see, si} ->
          if MapSet.member?(stale_pos, {ni, si}) do
            see |> mixed_drop(:result) |> Map.put("stale", true)
          else
            see
          end
        end)

      %{node | sees: new_sees}
    end)
  end

  # Every see across the slice as {global_ordinal, node_index, see_index, see}.
  defp flatten_sees(slice) do
    slice
    |> Enum.with_index()
    |> Enum.flat_map(fn {node, ni} ->
      node.sees |> Enum.with_index() |> Enum.map(fn {see, si} -> {ni, si, see} end)
    end)
    |> Enum.with_index()
    |> Enum.map(fn {{ni, si, see}, ord} -> {ord, ni, si, see} end)
  end

  # For each path, the ascending ordinals at which a WRITE (any non-read,
  # non-error effect touching that path) occurs. A write bumps the path's epoch.
  # Partition write ordinals into per-path buckets PLUS a GLOBAL bucket for writes
  # whose path could not be localized. A write we cannot pin to a path is treated
  # as touching EVERYTHING (a conservative epoch barrier): it bumps every read's
  # epoch, so a read is never collapsed across an un-localizable mutation. This
  # closes the operand-extraction / nil-path / wrapper holes uniformly — when in
  # doubt, do not collapse (L2 re-review).
  defp write_ordinals_by_path(flat) do
    # Each write contributes its ordinal to EVERY path it touches (a `touch f g`
    # mutates both f and g), plus the GLOBAL bucket when it has no localizable
    # path at all. Barrier on all operands, not just one (L2 re-review).
    writes =
      flat
      |> Enum.filter(fn {_ord, _ni, _si, see} -> write_see?(see) end)
      |> Enum.map(fn {ord, _ni, _si, see} -> {ord, write_paths(see)} end)

    by_path =
      writes
      |> Enum.reduce(%{}, fn {ord, paths}, acc ->
        Enum.reduce(paths, acc, fn path, a -> Map.update(a, path, [ord], &[ord | &1]) end)
      end)
      |> Map.new(fn {p, ords} -> {p, Enum.sort(ords)} end)

    global =
      writes
      |> Enum.filter(fn {_ord, paths} -> paths == [] end)
      |> Enum.map(&elem(&1, 0))
      |> Enum.sort()

    {by_path, global}
  end

  # Stale a read iff a strictly-later same-key read exists in the SAME epoch (no
  # write ordinal strictly between them). Walk reads in ordinal order; the LAST
  # read of each maximal write-free run is the keeper, earlier ones in that run
  # stale.
  defp collect_stale(reads, writes, acc) do
    ords = Enum.map(reads, fn {ord, ni, si, _see} -> {ord, {ni, si}} end) |> Enum.sort()

    Enum.reduce(Enum.with_index(ords), acc, fn {{ord, pos}, idx}, set ->
      later = Enum.drop(ords, idx + 1)

      same_epoch_later? =
        Enum.any?(later, fn {lord, _lpos} -> not write_between?(writes, ord, lord) end)

      if same_epoch_later?, do: MapSet.put(set, pos), else: set
    end)
  end

  defp write_between?(writes, a, b) do
    Enum.any?(writes, fn w -> w > a and w < b end)
  end

  # A see is a WRITE (epoch-bumping) when it is not a read and not an error
  # (errors are exempt evidence, never treated as state mutations here).
  defp write_see?(see) do
    Result.status(mixed_get(see, :result)) == :ok and Effect.classify(see) != :read
  end

  # The path a see touches: a native tool's `:path`/`:target` arg, or the file
  # operand of an sh `:argv` (the first non-flag after the head). nil when not
  # statically known. Conservative — an unknown path groups under nil and never
  # matches a real path's writes (so a read with an unknown path is collapsible
  # only against other unknown-path reads, which is sound: same key).
  # The SINGLE path a READ targets (a read touches one file): a native tool's
  # :path/:target, else the sh file operand (the last bare argv token). nil when
  # unresolved.
  defp args_path(args) do
    mixed_get_in(args, :path) || mixed_get_in(args, :target) ||
      List.last(argv_operands(mixed_get_in(args, :argv)))
  end

  # ALL paths a WRITE touches (a `touch f g` / `cp a b` mutates several). Returns
  # [] when none can be resolved — making the write a global barrier. Used only for
  # writes; reads key on their single args_path.
  defp write_paths(see) do
    case mixed_get(see, :args) do
      %{} = args ->
        native = [mixed_get_in(args, :path), mixed_get_in(args, :target)] |> Enum.reject(&is_nil/1)
        operands = argv_operands(mixed_get_in(args, :argv))
        Enum.uniq(native ++ operands)

      _ ->
        []
    end
  end

  # The bare (non-flag, non-assignment) operands of an sh argv, in order. The file
  # operands of the command; patterns/expressions are indistinguishable statically
  # so they are included too (conservative — an over-broad barrier only forgoes an
  # optimization, never collapses unsoundly).
  defp argv_operands([_head | rest]) when is_list(rest) do
    Enum.filter(rest, fn a -> is_binary(a) and not String.starts_with?(a, "-") and not String.contains?(a, "=") end)
  end

  defp argv_operands(_), do: []

  # The path component of a read key (for matching against write paths). The key
  # is {name, args}; reuse args_path so a native read keyed on :path/:target
  # matches a write to that same path (reads and writes share one extractor).
  defp key_path({_name, args}) when is_map(args), do: args_path(args)
  defp key_path(_), do: nil

  defp mixed_get_in(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, to_string(key))

  defp read_key(see), do: {to_string(mixed_get(see, :name)), mixed_get(see, :args)}

  # A see is collapsible by stale-read ONLY if it is ok, not already CSE-ref'd, and
  # its effect class is :read (idempotent + restorable). This is the effect-
  # soundness gate: a non-read call is never stale-collapsed.
  defp collapsible_read?(see) do
    ok_see?(see) and not Map.has_key?(see, "cse_ref") and Effect.read?(see)
  end

  # --- print-prune ------------------------------------------------------------

  defp print_prune(slice) do
    Enum.map(slice, fn node -> %{node | prints: []} end)
  end

  # --- shared helpers ---------------------------------------------------------

  defp ok_see?(see), do: Result.status(mixed_get(see, :result)) == :ok

  # A `sees` entry may be atom- or string-keyed depending on its origin; read
  # either (never mint an atom from data). PRESENCE-AWARE: a real `false`/`nil`
  # result must survive — a `||` fallback would fold `false` into "missing" and let
  # two distinct results (`false` and `nil`) share a CSE key, corrupting the tape
  # (S4 swarm finding). Probe the atom key first, then the string key, by presence.
  defp mixed_get(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, v} -> v
      :error -> Map.get(map, to_string(key))
    end
  end

  defp mixed_get(_map, _key), do: nil

  defp mixed_drop(map, key) when is_map(map) do
    map |> Map.delete(key) |> Map.delete(to_string(key))
  end

  # Coerce a bind/var name to a string (atom or binary), matching the projection's
  # name rendering so a read key compares equal to a bind key.
  defp name_str(n) when is_atom(n), do: Atom.to_string(n)
  defp name_str(n) when is_binary(n), do: n
  defp name_str(n), do: inspect(n)
end
