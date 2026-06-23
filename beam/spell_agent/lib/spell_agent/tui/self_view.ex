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
  alias SpellAgent.Tui.SelfView.{Budget, Idioms}

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
    width = normalize_dim(Keyword.get(opts, :width), 80)
    height = normalize_dim(Keyword.get(opts, :height), 24)

    # data/area MUST reflect the buffer the node actually renders INTO, so a view
    # that branches on data/area observes the same frame it is drawn on. Derive
    # the bag's area from the (normalized) render dimensions unless the caller
    # pinned an explicit :area. Without this, a 50×8 render would still report
    # 80×24 in data/area — a view lying to itself about its own size.
    area =
      Keyword.get(opts, :area) || %ExRatatui.Layout.Rect{x: 0, y: 0, width: width, height: height}

    bag = live_bag(Keyword.put(opts, :area, area))

    RenderProbe.render(node, width: width, height: height, data_env: bag)
  end

  @doc """
  The `view/think` tool entry (qualified name => `(args -> value)`).

  This is the L−1 PRIMITIVE on the freeform tool surface: the agent authors a
  layout node over its OWN run-trace and renders it headless to ASCII, reading the
  buffer back as reasoning input. The renderer reads its own output.

  It is the LIVE-BAG sibling of `layout/render` (`RenderProbe`): `layout/render`
  previews a node's SHAPE against an empty env ("what does this widget look
  like?"); `view/think` renders against the live self-bag ("what does my trace
  look like right now?"), so a node whose holes read `data/forest`/`data/status`
  shows the actual run.

  Args (string or atom keys), ONE of `:name` / `:source` required:
    * `:name` — a built-in trace idiom (W2): one of
      `#{Enum.join(Idioms.names(), "`, `")}`. The curated, token-earning
      projection — `(view/think {:name "errors-board"})`. Wins over `:source`.
    * `:source` or `:node` — an agent-authored layout node (W1). Author it with
      `tmpl::` so its `~holes` read `data/forest`, `data/status`, `data/turns`, …
    * `:width` / `:height` — optional positive integers (default 80×24); `data/area`
      tracks them so a size-aware view sees the frame it draws on.

  Returns a string-keyed map: `%{"buffer" => ascii, "width" => w, "height" => h}`
  on success, or `%{"err" => "..."}` on any failure. Read-only + total by
  construction (see the module doc).
  """
  @spec tools() :: %{optional(String.t()) => (map() -> term())}
  def tools do
    %{
      "view/think" => fn args ->
        width = strget(args, "width")
        height = strget(args, "height")

        case resolve_node(args) do
          {:ok, node} -> think_to_tool(node, width, height)
          {:error, msg} -> %{"err" => msg}
        end
      end
    }
  end

  # The node to render: a NAMED built-in idiom (:name, W2) or an agent-authored
  # node (:source/:node, W1). :name wins when both are given (the curated
  # projection is the more specific intent). An unknown :name lists what IS
  # available rather than silently falling through to "missing source".
  defp resolve_node(args) do
    name = strget(args, "name")
    authored = strget(args, "source") || strget(args, "node")

    cond do
      is_binary(name) ->
        case Idioms.node(name) do
          nil ->
            {:error,
             "view/think: unknown idiom #{inspect(name)}; available: #{Enum.join(Idioms.names(), ", ")}"}

          node ->
            {:ok, node}
        end

      is_map(authored) ->
        {:ok, authored}

      true ->
        {:error,
         "view/think requires a :name (a built-in idiom: #{Enum.join(Idioms.names(), ", ")}) " <>
           "or a :source (an authored layout node)"}
    end
  end

  # Render an agent-authored node over the live self-bag and shape the result for
  # the tool surface (string-keyed map / %{"err"}). `width`/`height` may be nil
  # (use defaults), an integer, or a string (normalize_dim handles all three).
  #
  # The render is GUARDED by the loop budget (W3): the render→observe→act cycle is
  # a loop, and a loop can spin. Charging the budget BEFORE returning a buffer lets
  # a runaway self-view loop be cut deterministically (over-budget → %{err}) and a
  # stable view be flagged (fixpoint → a note), per the PROJ-001 security note.
  defp think_to_tool(node, width, height) do
    opts =
      [store: @default_store]
      |> maybe_put(:width, width)
      |> maybe_put(:height, height)

    case render(node, opts) do
      {:ok, %{buffer: buffer, width: w, height: h}} ->
        guard_render(buffer, w, h)

      {:error, :empty_render} ->
        %{
          "err" =>
            "view/think produced no renderable widgets; a node must be a view/* " <>
              "widget or split tree (a native `pane` node needs the live app)"
        }

      {:error, reason} ->
        %{"err" => "view/think failed: #{format_reason(reason)}"}
    end
  end

  # Charge the loop budget for this render and shape the result. Over budget is a
  # HARD cut (no buffer, an %{err} naming the cap); a fixpoint (same buffer as the
  # previous render) is a SOFT signal (the buffer plus a "note") so the agent knows
  # re-rendering an unchanged view teaches it nothing new.
  defp guard_render(buffer, w, h) do
    base = %{"buffer" => buffer, "width" => w, "height" => h}

    case Budget.charge(buffer) do
      {:ok, %{renders: n}} ->
        Map.put(base, "renders", n)

      {:fixpoint, %{renders: n}} ->
        base
        |> Map.put("renders", n)
        |> Map.put(
          "note",
          "this view is unchanged from your last render — a fixpoint; " <>
            "re-rendering it will not show anything new"
        )

      {:over_budget, %{renders: n, max: max}} ->
        %{
          "err" =>
            "view/think render budget exhausted (#{n}/#{max} this mission); " <>
              "the render→observe loop was cut to protect the turn budget"
        }
    end
  end

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, key, value), do: Keyword.put(opts, key, value)

  defp format_reason({:render_failed, message}), do: message

  defp strget(m, key) when is_map(m), do: Map.get(m, key) || Map.get(m, safe_atom(key))
  defp strget(_m, _key), do: nil

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end

  defp safe_atom(_), do: nil

  defp default_area, do: %ExRatatui.Layout.Rect{x: 0, y: 0, width: 80, height: 24}

  # Mirror RenderProbe's dimension contract: a positive integer is honored, a
  # binary positive integer is parsed, anything else falls back to the default —
  # so the bag's data/area and the actual render size can never disagree.
  defp normalize_dim(n, _default) when is_integer(n) and n > 0, do: n

  defp normalize_dim(s, default) when is_binary(s) do
    case Integer.parse(String.trim(s)) do
      {n, ""} when n > 0 -> n
      _ -> default
    end
  rescue
    _ -> default
  end

  defp normalize_dim(_, default), do: default
end
