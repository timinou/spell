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

  alias SpellAgent.Hist.{Effect, Node, Result}

  @doc """
  Reduce a node slice (root-first) with the lossless tier.

  Pure over its input — no store reads — so a caller folds a projected slice
  without touching the DAG. Returns the reduced `[Node.t()]` in the same order.
  """
  @spec lossless([Node.t()]) :: [Node.t()]
  def lossless(slice) when is_list(slice) do
    slice
    |> dead_bind_elim()
    |> tool_cse()
    |> stale_read_collapse()
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
    # Index the LAST occurrence position of each (name,args) key over ok, read-
    # class, non-cse sees, so we keep that one and stale the earlier copies.
    flat =
      for {node, ni} <- Enum.with_index(slice),
          {see, si} <- Enum.with_index(node.sees),
          collapsible_read?(see),
          do: {read_key(see), {ni, si}}

    last_pos =
      Enum.reduce(flat, %{}, fn {key, pos}, acc -> Map.put(acc, key, pos) end)

    slice
    |> Enum.with_index()
    |> Enum.map(fn {node, ni} ->
      new_sees =
        node.sees
        |> Enum.with_index()
        |> Enum.map(fn {see, si} ->
          if collapsible_read?(see) and Map.get(last_pos, read_key(see)) != {ni, si} do
            see |> mixed_drop(:result) |> Map.put("stale", true)
          else
            see
          end
        end)

      %{node | sees: new_sees}
    end)
  end

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
  # either (never mint an atom from data).
  defp mixed_get(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, to_string(key))
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
