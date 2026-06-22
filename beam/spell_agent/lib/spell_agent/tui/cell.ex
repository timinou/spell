defmodule SpellAgent.Tui.Cell do
  @moduledoc """
  The reactive-cell resolver (PROJ-004 W0) — the off-frame, read-only sibling of
  `SpellAgent.Tui.HoleResolver`.

  ## What a cell is

  A cell is a *declared data dependency*: a frozen `tmpl::` query plus a name. The
  runtime resolves it OFF the frame clock (on cursor/store change, debounced — W3)
  and injects the result into the `data/*` bag under the cell's name. A render
  hole then references that key as ORDINARY pure data — the render never performs
  the effect. This is the "declare vs. resolve" relocation of philosophy Layer -4:
  looking stays pure; the live query happens on a slow clock, once, cached.

  ## The symmetry with `HoleResolver`

  A render hole is a PURE cell: `deps -> value`, FRAME clock, ZERO tools.
  A reactive cell is an EFFECTFUL hole: `deps -> value`, SLOW clock, READ-ONLY
  tools, async + cached. `resolve/3` is the exact dual of
  `HoleResolver.eval_hole_raw/2`: it thaws the same frozen codec form and
  evaluates it through the same sandboxed `PtcRunner.Lisp.run/2` — the ONE
  difference is the capability tier. Where a render hole gets `tools: %{}` (no
  effects, ever), a cell gets a READ-ONLY tools map (W1: `find`/`get`/hist-reads/
  harness-reads — never a mutator). The boundary moved; it did not vanish.

  ## Capability boundary (security is load-bearing here — spec)

  `resolve/3` takes the tools map as an explicit argument so the caller — never
  this module — decides the capability tier. W1 supplies the vetted read-only
  tier; the default is `%{}` (no tools), so a cell with no tier is exactly as
  inert as a render hole. A cell can therefore NEVER acquire a mutator it was not
  explicitly granted, and the grant lives in one auditable place.

  ## Off-frame budget

  A cell runs on the SLOW clock, not the frame loop, so it tolerates a larger
  budget than a render hole's 200ms — a `tool/find` over a large tree legitimately
  takes longer than a frame. `@cell_timeout_ms` (default 2000ms) bounds a runaway
  query without the frame-tight ceiling. The clock layer (W3) additionally
  debounces and runs the resolve in a `Task`, so even this budget never blocks the
  UI.

  ## Failure ladder (never brick the bag)

  A thaw/eval failure (raise, unknown tool, over budget, wrong shape) yields
  `:error`; the clock layer (W3) keeps the last-good value (or omits the key)
  rather than corrupting `data/*`. Total + bounded, exactly like the render host.
  """

  alias PtcRunner.Lisp
  alias PtcRunner.Lisp.{Formatter, QuoteData}

  @hole_key "__hole__"
  @splice_key "__splice__"

  # The off-frame budget for one cell resolve. Larger than a render hole's 200ms
  # because a cell runs on the SLOW clock (cursor/store change), where a real
  # read-only query (e.g. `tool/find` over a big tree) legitimately costs more
  # than a frame. The clock layer (W3) runs this in a Task and debounces, so the
  # budget bounds a runaway query without ever blocking the UI.
  @cell_timeout_ms 2000

  @typedoc "A live data environment: string-keyed `data/*` bindings."
  @type data_env :: %{optional(String.t()) => term()}

  @typedoc "A read-only tools map (name -> arity-1 callable). Empty = no effects."
  @type tools :: %{optional(String.t()) => (map() -> term())}

  @doc """
  Resolve a cell's frozen query against `env` with `tools`, returning
  `{:ok, value} | :error`.

  `frozen` is the same codec data a `tmpl::` hole carries — either a bare frozen
  form, or a `%{"__hole__" => …}` / `%{"__splice__" => …}` wrapper (so a query
  authored as `(tmpl:: (tool/find …))` resolves whether the reader froze it as a
  bare form or a hole wrapper). `tools` is the capability tier (default `%{}` —
  no effects); W1 supplies the vetted read-only tier.

  Total + bounded: any failure (thaw, format, eval, raise, over budget, unknown
  tool) collapses to `:error`. Never raises.
  """
  @spec resolve(term(), data_env(), tools()) :: {:ok, term()} | :error
  def resolve(frozen, env, tools \\ %{}) when is_map(env) and is_map(tools) do
    eval(unwrap(frozen), env, tools)
  end

  # A query authored as `(tmpl:: <form>)` may arrive wrapped as a hole/splice
  # leaf (when the reader lowered a top-level `~form`) or as a bare frozen form
  # (the common case — the whole query IS the deferred expression). Unwrap a
  # single hole/splice layer so both author shapes resolve identically; a splice
  # query is treated as its value form (the cell stores the resolved list).
  defp unwrap(%{@hole_key => inner}), do: inner
  defp unwrap(%{@splice_key => inner}), do: inner
  defp unwrap(other), do: other

  # Thaw the frozen codec data to source and evaluate it with `data/*` bound and
  # the granted READ-ONLY tools. Returns {:ok, value} | :error. Total + bounded.
  defp eval(frozen, env, tools) do
    with {:ok, raw} <- QuoteData.from_data_safe(frozen),
         source when is_binary(source) <- Formatter.format(raw),
         {:ok, step} <-
           Lisp.run(source,
             context: env,
             tools: tools,
             caller: :in_process_v1,
             timeout: @cell_timeout_ms
           ) do
      {:ok, step.return}
    else
      _ -> :error
    end
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  @doc "The off-frame resolve budget in milliseconds."
  @spec timeout_ms() :: pos_integer()
  def timeout_ms, do: @cell_timeout_ms
end
