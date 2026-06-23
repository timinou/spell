defmodule SpellAgent.Tui.SelfView do
  @moduledoc """
  L−1 (PROJ-001 / PLAN-016): the renderer reads its OWN output. The interface
  stops being a one-way display for a human and becomes EXTERNAL WORKING MEMORY
  for the agent — it authors a headless view over its own live run-trace, renders
  it to an ASCII buffer (no screen), and reads that buffer back as reasoning input.

  This module is the W0 SEAM: the one place a tool running in the mission process
  reaches the LIVE trace and renders a view over it, off-screen.

  ## The trace is already a value (why this is a seam, not a rewrite)

  `SpellAgent.Tui.DataBag.build/2` is the single projection of "the agent's trace
  as `data/*`": `data/forest` is the span forest (turns, tool calls, errors,
  def-env), `data/status`/`data/turns`/`data/tools` the run summary, `data/ui` the
  gaze. `SpellAgent.Tui.RenderProbe.render/2` already turns an agent-authored
  layout node into a headless ASCII buffer (`init_test_terminal` + `draw` +
  `get_buffer_content`), resolving `tmpl::` holes against a supplied `data_env`.

  L−1 is the COMPOSITION the two halves were missing: render a node whose holes
  resolve against the agent's OWN LIVE bag (not a caller-supplied empty env), so
  the view SHOWS the run-trace. `live_bag/1` builds that bag; `render/2` draws a
  node over it.

  ## The seam reaches the forest by GLOBAL NAME, not a captured closure

  `Session.run/1` assembles its tool map internally — there is no per-mission
  injection hook — so a self-view tool cannot capture an App pid. It does not need
  to: the span forest lives in `SpellAgent.Tui.Store`, a globally-NAMED singleton
  in the supervision tree, and production mounts the App against exactly that
  global Store (`SpellAgent.tui/1`: `store: SpellAgent.Tui.Store`). So
  `live_bag/1` reads the global Store and gets the live mission trace. The GAZE
  (cursor) is App-local and unreachable by name; a self-view therefore renders
  over a DEFAULT gaze — sufficient for a trace board (the L−1 payload is the
  forest, not the cursor). Cursor-faithful self-views are a later refinement.

  ## Read-only by construction (capability discipline, inherited from PROJ-004)

  A self-view RENDERS; it never mutates. It builds a bag from live state and draws
  it to a THROWAWAY terminal — there is no path to the keymap registry, the
  durable store, or the shell. The render is total: a malformed widget degrades to
  a gap and the throwaway terminal is always restored (`RenderProbe` guarantees
  both). "Looking never acts" holds: this only ever looks.

  ## Pure core, named edge (mirrors the Cell split)

  `live_bag/1` takes an explicit `:store` so a test drives it against a seeded,
  unnamed Store; it defaults to the global name for production. Nothing here owns
  process state — the same testability discipline as `SpellAgent.Tui.Cell`.
  """

  alias SpellAgent.Tui.{DataBag, RenderProbe}

  @default_store SpellAgent.Tui.Store

  @typedoc "A self-view render result: the ASCII buffer plus its dimensions."
  @type render_result :: RenderProbe.render_result()

  @doc """
  Build the agent's live self-bag — its own run-trace projected to `data/*`.

  Reads the span forest from the Store (default: the global
  `SpellAgent.Tui.Store`; override with `:store` for tests) and projects it
  through the SAME `DataBag.build/2` the live render path uses, so a self-view
  sees exactly the `data/*` keys a pane sees: `data/forest`, `data/status`,
  `data/turns`, `data/tools`, `data/forest-count`, `data/ui`, ….

  No App state is required: the forest is the trace, and the gaze defaults (the
  App-local cursor is not reachable by name). `area` defaults to an 80×24 rect so
  area-keyed holes resolve; override with `:area`.

  Total: a sick/absent Store degrades to an empty forest (DataBag's own
  rescue ladder), never raises.
  """
  @spec live_bag(keyword()) :: %{optional(String.t()) => term()}
  def live_bag(opts \\ []) do
    store = Keyword.get(opts, :store, @default_store)
    area = Keyword.get(opts, :area, default_area())

    # Only :store and :ui are read by DataBag for the trace; everything else
    # (running?/result/composer) is summary the self-view may show but does not
    # need. A bare state map keeps the seam honest: no App struct, no registries.
    state = %{store: store, ui: Keyword.get(opts, :ui)}
    DataBag.build(state, area)
  end

  @doc """
  Render a layout `node` over the agent's LIVE self-bag, headless, to ASCII.

  This is the L−1 primitive: the node's `tmpl::` holes resolve against
  `live_bag/1` (the run-trace), then `RenderProbe.render/2` draws it to a
  throwaway terminal and returns `{:ok, %{buffer, width, height}}`. The agent
  reads that buffer back as reasoning input — the renderer reading its own output.

  Options: `:width`/`:height` (render size), `:store`/`:ui`/`:area` (forwarded to
  `live_bag/1`). A pane-only or empty node yields `{:error, :empty_render}`; any
  raise/throw during resolve/layout/draw is caught (`RenderProbe` totality).
  """
  @spec render(term(), keyword()) :: {:ok, render_result()} | {:error, term()}
  def render(node, opts \\ []) do
    bag = live_bag(opts)

    RenderProbe.render(node,
      width: Keyword.get(opts, :width, 80),
      height: Keyword.get(opts, :height, 24),
      data_env: bag
    )
  end

  defp default_area, do: %ExRatatui.Layout.Rect{x: 0, y: 0, width: 80, height: 24}
end
