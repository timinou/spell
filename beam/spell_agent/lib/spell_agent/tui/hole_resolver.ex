defmodule SpellAgent.Tui.HoleResolver do
  @moduledoc """
  The render-domain hole host (PLAN-012 W3) — the small, capability-bounded
  evaluator that thaws a `tmpl::` template's deferred holes against a live
  `data/*` environment, every frame.

  ## What a hole is

  `tmpl::` (PLAN-012 W2) freezes each `~form` as inert codec data:

      %{"__hole__"   => <QuoteData encoding of form>}   # a value hole
      %{"__splice__" => <QuoteData encoding of form>}   # a list-splice hole

  The persisted layout tree carries these leaves verbatim. `resolve_holes/2`
  walks the tree and, for each hole, THAWS the form (`QuoteData.from_data` ->
  RawAST -> `Formatter` source) and EVALUATES it through the SAME sandboxed
  `PtcRunner.Lisp.run/2` the rest of the agent uses, with `data/*` bound. The
  resolved value replaces the hole; a `__splice__`'s resolved list is FLATTENED
  into its parent sequence.

  This is the render domain's "host" — the sibling of `Reaction.Ptc` (gaze
  transforms) and `Tui.Materialize` (map -> widget). Construction (the reader,
  W2) is pure; only HERE does a frozen form become behaviour, and only against a
  typed, capability-bounded surface — never a blank `eval` (quoting-spec §6).

  ## Capability boundary (render purity — philosophy Layer -4)

  The eval runs with NO tools map, so a hole CANNOT call `tool/…`, `layout/set`,
  `theme/set`, or any effecting verb — they resolve to "unknown tool" and the
  hole degrades. A hole sees only pure builtins + the injected `data/*`. Looking
  never acts.

  ## Failure ladder (never brick the frame)

  Per hole: a thaw/eval failure (raise, unknown tool, wrong shape) yields the
  `@placeholder` ("·"), never a raised frame. A future `last-good` cache (W6)
  slots in ahead of the placeholder. The rest of the tree always resolves.
  """

  alias PtcRunner.Lisp
  alias PtcRunner.Lisp.{Formatter, QuoteData}

  @hole_key "__hole__"
  @splice_key "__splice__"
  @placeholder "·"

  @typedoc "A live data environment: string-keyed `data/*` bindings."
  @type data_env :: %{optional(String.t()) => term()}

  @doc """
  Resolve every `__hole__` / `__splice__` in `tree` against `data_env`.

  A `__hole__` is replaced by its evaluated value; a `__splice__` element in a
  list is flattened in. Plain maps/lists recurse; scalars pass through. Never
  raises — a failing hole becomes the `·` placeholder.
  """
  @spec resolve_holes(term(), data_env()) :: term()
  def resolve_holes(tree, data_env) when is_map(data_env) do
    walk(tree, data_env)
  end

  # ---- the walk ----

  # A value hole: thaw + eval, substitute the value (single pass — the result is
  # NOT re-walked, so a hole that resolves to hole-shaped data is left as data).
  defp walk(%{@hole_key => frozen}, env), do: eval_hole(frozen, env)

  # A splice hole OUTSIDE a list context (a bare map value): resolve to its list,
  # but with no parent sequence to flatten into it stays a list value.
  defp walk(%{@splice_key => frozen}, env) do
    case eval_hole_raw(frozen, env) do
      {:ok, list} when is_list(list) -> list
      _ -> @placeholder
    end
  end

  defp walk(map, env) when is_map(map) and not is_struct(map) do
    Map.new(map, fn {k, v} -> {k, walk(v, env)} end)
  end

  defp walk(list, env) when is_list(list) do
    Enum.flat_map(list, fn elem -> walk_seq_elem(elem, env) end)
  end

  defp walk(other, _env), do: other

  # A list element: a `__splice__` flattens its resolved list into the parent; any
  # other element resolves to exactly one element.
  defp walk_seq_elem(%{@splice_key => frozen}, env) do
    case eval_hole_raw(frozen, env) do
      {:ok, list} when is_list(list) -> Enum.map(list, &walk(&1, env))
      _ -> [@placeholder]
    end
  end

  defp walk_seq_elem(elem, env), do: [walk(elem, env)]

  # ---- hole evaluation (capability-bounded) ----

  # Resolve a value hole to its value, or the placeholder on any failure.
  defp eval_hole(frozen, env) do
    case eval_hole_raw(frozen, env) do
      {:ok, value} -> value
      :error -> @placeholder
    end
  end

  # Thaw the frozen codec data to source and evaluate it with `data/*` bound and
  # NO tools (capability boundary). Returns {:ok, value} | :error. Total.
  defp eval_hole_raw(frozen, env) do
    with {:ok, raw} <- QuoteData.from_data_safe(frozen),
         source when is_binary(source) <- Formatter.format(raw),
         {:ok, step} <- Lisp.run(source, context: env, caller: :in_process_v1) do
      {:ok, step.return}
    else
      _ -> :error
    end
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  @doc "The placeholder a failed hole renders as."
  @spec placeholder() :: String.t()
  def placeholder, do: @placeholder
end
