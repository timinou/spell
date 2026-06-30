defmodule SpellAgent.Tui.LensFn do
  @moduledoc """
  The edit-domain transform host (PLAN-021 W2) — evaluates a `lens/update` `:fn`
  against the value currently at a path, the EDIT-time sibling of
  `HoleResolver` (the RENDER-time host).

  ## Two clocks, one form

  `lens/update`'s `:fn` is a deferred form (frozen codec data, from `(quote …)`
  or a `tmpl::`). It runs ONCE, at edit time, to compute the new value at a path.
  Crucially, its result may itself CONTAIN render-time holes — so a single
  `lens/update` both edits now AND keeps the edited leaf live:

      edit clock   (HERE)            render clock   (HoleResolver, every frame)
      ─────────────────────          ──────────────────────────────────────────
      data/current  = value@path     data/status / data/ui / data/forest = live
      ~(now expr)  evaluates         ~expr  stays a frozen __hole__
      → baked into the new value     → re-resolved on every subsequent frame

  This is why a path edit does not freeze the UI: any `~expr` the `:fn` leaves
  un-`now`'d survives as a hole and keeps rendering live. The mechanism is just
  `tmpl::`'s existing `now`/`~` split composed across the edit boundary — no new
  quoting machinery (verified end-to-end against the live runtime, FEAT-027).

  ## `data/current` is the ground; `%` is sugar

  The value at the path is bound as `data/current` — consistent with every other
  Spell transform (holes, cells, reactions) reading input from the ambient
  `data/*` environment rather than a positional param. A BARE top-level `%` in
  the `:fn` source is rewritten to `data/current` before evaluation, as terse
  sugar; `%` inside a `#(…)` keeps its Clojure anonymous-arg meaning (the rewrite
  is scoped to the standalone token, never the `%N` forms).

  ## Capability boundary (same as the render host)

  The `:fn` evaluates with `data/*` bound and NO tools map — it cannot call
  `tool/…`, `layout/set`, or any effecting verb (they degrade to unknown-tool).
  An edit transform LOOKS at the current value + run state and returns a new
  value; it never acts. Total + bounded: any thaw/eval failure returns
  `{:error, reason}` and the caller keeps the last-good tree.
  """

  alias PtcRunner.Lisp
  alias PtcRunner.Lisp.{Formatter, QuoteData}

  # Same budget as a render hole: the fn evaluates synchronously on the edit path,
  # so a runaway pure transform degrades fast rather than stalling. Cold-start
  # clears in well under this; a loop is cut to a brief blink.
  @fn_timeout_ms 200

  @typedoc "A live data environment: string-keyed `data/*` bindings."
  @type data_env :: %{optional(String.t()) => term()}

  @doc """
  Evaluate a frozen `:fn` (codec data) against `current` (the value at the path),
  returning `{:ok, new_value}` or `{:error, reason}`.

  `current` is bound as `data/current`; any other `data/*` in `env` is merged in
  (so a transform can read run-state alongside the focused value). The result is
  returned VERBATIM — render-time `__hole__` leaves inside it are preserved, not
  resolved, so the edited leaf stays live.
  """
  @spec eval(term(), term(), data_env()) :: {:ok, term()} | {:error, String.t()}
  def eval(frozen, current, env \\ %{}) when is_map(env) do
    context = Map.put(env, "current", current)

    with {:ok, raw} <- thaw(frozen),
         source when is_binary(source) <- Formatter.format(raw),
         rewritten = rewrite_percent(source),
         {:ok, step} <-
           Lisp.run(rewritten, context: context, caller: :in_process_v1, timeout: @fn_timeout_ms) do
      {:ok, step.return}
    else
      {:error, reason} -> {:error, describe(reason)}
      _ -> {:error, "fn did not evaluate to a value"}
    end
  rescue
    e -> {:error, Exception.message(e)}
  catch
    kind, value -> {:error, Exception.format_banner(kind, value)}
  end

  # ---- thaw the frozen :fn to RawAST ----

  # The :fn arrives as codec data — either a `(quote form)` encoding or a tmpl::
  # `__hole__` wrapper. Unwrap a hole to its inner form; otherwise thaw directly.
  defp thaw(%{"__hole__" => inner}), do: QuoteData.from_data_safe(inner)
  defp thaw(frozen), do: QuoteData.from_data_safe(frozen)

  # ---- `%` -> `data/current` sugar ----

  # Rewrite a BARE top-level `%` token to `data/current`. The match is
  # word-boundaried so `%1`/`%2` (anonymous-fn positional args) and any `%`-prefixed
  # symbol are left untouched — only the standalone `%` the agent writes as
  # "the current value" is rewritten. Operates on the formatted source string,
  # which is the single, normalized rendering of the thawed form.
  @percent ~r/(?<![\w%])%(?![\w%])/
  defp rewrite_percent(source), do: Regex.replace(@percent, source, "data/current")

  defp describe(reason) when is_binary(reason), do: reason
  defp describe(reason), do: inspect(reason)
end
