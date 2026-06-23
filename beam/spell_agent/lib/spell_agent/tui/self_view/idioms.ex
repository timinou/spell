defmodule SpellAgent.Tui.SelfView.Idioms do
  @moduledoc """
  PLAN-016 W2 — the trace projections worth rendering.

  L−1 only earns its tokens if a self-view COMPRESSES the run-trace better than
  re-reading the raw forest (the PROJ-001 open question: "what projection earns
  its tokens?"). This module is the curated answer: a handful of NAMED views, each
  a `tmpl::` template over `data/forest`, that an agent renders by name —
  `(view/think {:name "errors-board"})` — instead of re-deriving the same
  projection every time.

  ## Why named templates, not ad-hoc nodes

  `view/think {:source <node>}` (W1) already lets the agent author any view. But
  the projections that actually help — "just the errors, with their turn context",
  "the tool calls I made", "a one-line run summary" — are stable and worth getting
  RIGHT once. A named idiom is the distilled form: the agent asks for the view by
  intent, the runtime supplies the projection. (This is also the seam PROJ-003
  will grow into — idioms the agent distills from its OWN prior success — but here
  they are hand-authored, the grammar before the learned sentences.)

  ## The projections (each compresses a different question)

    * `errors-board` — ONLY the errored spans (`status == :error`), each as
      `label — reason`. Answers "what broke?" without the noise of the ok spans.
    * `tool-calls` — every `:tool` span as `status label`, the working set the run
      touched. Answers "what did I do?".
    * `trace-summary` — a one-paragraph overview: turn/tool counts + a status
      tally (ok/error/running). Answers "where am I?" at a glance.

  ## Construction

  Each idiom is a `tmpl::` source string compiled to a frozen layout node via
  `PtcRunner.Lisp.run/1` — the SAME producer the live layout path uses (these are
  layout DATA, not prompts; cf. `SpellAgent.Tui.DefaultLayout`, which builds its
  frozen nodes in Elixir too). The frozen nodes are built once and cached in a
  module attribute, so resolving an idiom is a map lookup, not a recompile.

  The forest fields the templates read are the SANITIZED bag shape (verified):
  `status`/`kind` are ATOMS (`:error`, `:tool`), `label` is a string, `meta` a
  string-keyed map, `turns` a list. The comparisons below (`(= (get s :status)
  :error)`) match those atoms.
  """

  alias PtcRunner.Lisp

  # ── idiom templates (tmpl:: layout data over data/forest) ──────────────────
  #
  # A splice `~@(...)` flattens a computed list into a :list widget's :items, the
  # established variable-length-rows idiom. A failed hole renders as `·` and never
  # breaks the frame (HoleResolver ladder), so a malformed forest degrades, never
  # crashes.

  @errors_board ~S"""
  (tmpl:: {:type "list"
           :block {:type "block" :title " errors " :borders ["all"]}
           :items [~@(map (fn [s]
                            (str (get s :label)
                                 (let [r (get (get s :meta) :reason)]
                                   (if r (str " — " r) ""))))
                          (filter (fn [s] (= (get s :status) :error))
                                  (vals data/forest)))]})
  """

  @tool_calls ~S"""
  (tmpl:: {:type "list"
           :block {:type "block" :title " tool calls " :borders ["all"]}
           :items [~@(map (fn [s] (str (get s :status) "  " (get s :label)))
                          (filter (fn [s] (= (get s :kind) :tool))
                                  (vals data/forest)))]})
  """

  @trace_summary ~S"""
  (tmpl:: {:type "paragraph"
           :block {:type "block" :title " trace " :borders ["all"]}
           :text ~(let [spans (vals data/forest)
                        errs  (count (filter (fn [s] (= (get s :status) :error)) spans))]
                    (str "turns " data/turns
                         " · tools " data/tools
                         " · spans " data/forest-count
                         " · errors " errs))})
  """

  @templates %{
    "errors-board" => @errors_board,
    "tool-calls" => @tool_calls,
    "trace-summary" => @trace_summary
  }

  # Compile each template to its frozen layout node ONCE, at module load. A
  # template that fails to compile is omitted (never a load-time crash) — but the
  # set is pinned by a test so a typo fails loudly in CI, not silently at runtime.
  @frozen (for {name, src} <- @templates, into: %{} do
             case Lisp.run(src) do
               {:ok, %{return: node}} -> {name, node}
               _ -> {name, nil}
             end
           end)
          |> Enum.reject(fn {_n, node} -> is_nil(node) end)
          |> Map.new()

  @doc """
  The frozen layout node for a named idiom, or `nil` if the name is unknown.

  Resolution is a map lookup over nodes compiled at load time — rendering an idiom
  costs only the render, never a recompile.
  """
  @spec node(String.t()) :: map() | nil
  def node(name) when is_binary(name), do: Map.get(@frozen, name)
  def node(_), do: nil

  @doc "The names of every available idiom (for the tool error message + tests)."
  @spec names() :: [String.t()]
  def names, do: @frozen |> Map.keys() |> Enum.sort()
end
