defmodule SpellAgent.Tui.Cockpit do
  @moduledoc """
  Materializes `data/sessions` — the multi-session cockpit's one data binding
  (FEAT-046, PLAN-026 W-C1).

  The cockpit is a `body`-slot LAYOUT VALUE (`priv/tui/cockpit_layout.ptc`), not
  an Elixir view module. This module is the *only* new read-Elixir the cockpit
  needs: the body-side materializer that turns "N live sessions" into one bounded,
  best-effort list of string-keyed rows a PTC layout projects into a grid of
  cards. Every VISUAL decision (grid, colors, ordering, card content) lives in the
  `.ptc`; this module DECIDES NOTHING about how it looks. It only:

    * **unions** the two halves of "what sessions exist" —
      * live meta: `SpellAgent.SessionRegistry.lineage/0`
        (`owner`/`parent_id`/`intent`/`region`/`status`), and
      * content: each session's conversation trace via
        `SpellAgent.Hist.Trace.rows/2` (turns, cost, last activity, last-N spans);
    * **bounds** the cost (`@max_sessions`, `@snapshot_turns`) — the atom-table
      and render-cost floor;
    * **falls back** — a sick registry yields fewer rows (or none), a sick
      per-session read yields a minimal "(unavailable)" card, never a crash.

  ## Why read-through-store, not pid-attach

  The content is read from the SHARED Hist substrate (`Hist.Trace.rows/2`), NOT by
  attaching to the target session's process. This is the read-only cross-session
  path the freeform architecture prefers (`FUP-006`): a reader touches only plain
  data, never the target's event loop, so it cannot perturb a running mission. The
  cost is refresh-clock lag (the reader sees the store as of the last recorded
  turn), which is the correct tradeoff for a read-only overview.

  ## Clock

  `sessions/1` is O(@max_sessions) store reads. It belongs on the QUERY clock (a
  `reproject` / a periodic refresh), NEVER the frame clock — a per-keystroke
  cross-session read would regress the PLAN-023 keystroke-cost invariant. The
  caller (App) is responsible for calling it off the frame path and caching the
  result as a heavy `data/*` member, exactly like `forest`/`vms`.
  """

  alias SpellAgent.Tui.DataSource

  # The `data/*` binding this source produces. The layout reads `data/sessions`.
  @source_name "sessions"

  # The cockpit's data source AS DATA (PLAN-027 M1): a frozen PTC program that
  # unions the live lineage with each session's content summary. `install/0`
  # freezes + registers this; the Elixir `sessions/1` below is the compiled
  # fallback floor if the file is missing/malformed (never-brick). `@external_resource`
  # recompiles on a file edit; `install/0` re-reads at runtime so a live edit is
  # pickup-able without recompiling Elixir at all.
  @sources_path Path.join([:code.priv_dir(:spell_agent) |> to_string(), "tui", "cockpit_sources.ptc"])
  @external_resource @sources_path
  @sources_source (case File.read(@sources_path) do
                     {:ok, s} -> s
                     _ -> ""
                   end)

  # The cockpit LAYOUT as data (PLAN-027 M6): the program that shadows the `body`
  # slot with the live per-session card grid. `show/0` runs it. An edit here
  # reshapes the cockpit with no recompile.
  @layout_path Path.join([:code.priv_dir(:spell_agent) |> to_string(), "tui", "cockpit_layout.ptc"])
  @external_resource @layout_path
  @layout_source (case File.read(@layout_path) do
                    {:ok, s} -> s
                    _ -> ""
                  end)

  # The cockpit's NAVIGATION reactions as data (PLAN-027 M6): drill/back authored
  # as keymap/define-reaction returning effect envelopes. `install_reactions/0`
  # runs this at boot so the cockpit's navigation is live + rebindable.
  @reactions_path Path.join([:code.priv_dir(:spell_agent) |> to_string(), "tui", "cockpit_reactions.ptc"])
  @external_resource @reactions_path
  @reactions_source (case File.read(@reactions_path) do
                       {:ok, s} -> s
                       _ -> ""
                     end)

  # The grid is bounded: at most this many session cards. A hard floor on both the
  # render cost (N panes) and the atom/term cost of the projected data. Sessions
  # beyond this are not shown in the overview (newest-first from the registry).
  @max_sessions 12

  @typedoc """
  One cockpit row — a session's live meta unioned with a bounded content summary,
  string-keyed for a PTC layout to project. Always has the meta keys; the content
  keys degrade to zero/empty on a per-session read failure.
  """
  @type row :: %{optional(String.t()) => term()}

  @doc "The bound on shown sessions (test + layout reference)."
  @spec max_sessions() :: pos_integer()
  def max_sessions, do: @max_sessions

  @doc "The `data/*` key this source binds (`data/sessions`)."
  @spec source_name() :: String.t()
  def source_name, do: @source_name

  @doc """
  Register the cockpit as ONE query-clock data source (PLAN-027 M0 → M1).

  This is the PERIPHERY policy call — the one place that says "`data/sessions`
  exists". The render loop (`App.reproject`) never names this source; it resolves
  whatever is registered.

  M1 (FUP-036): the producer is now DATA — the frozen PTC program in
  `priv/tui/cockpit_sources.ptc`, which unions the live lineage with each
  session's content summary via the read-only source tools. `install/0` runs
  that `.ptc` (its `data-source/register` call installs the frozen program).
  If the file is missing/malformed, fall back to registering the compiled Elixir
  `sessions/1` closure (the never-brick floor — the body keeps the feature
  working even when its data authoring is broken). Best-effort: a no-op if the
  registry is absent (headless).
  """
  @spec install() :: :ok | {:error, String.t()}
  def install do
    case install_from_data() do
      :ok -> :ok
      :error -> install_fallback()
    end
  end

  # Run the cockpit_sources.ptc program: its `data-source/register` verb installs
  # the frozen producer. Returns :ok only if the source is actually registered
  # afterward (a parse/eval failure or a rejected registration falls through to
  # the Elixir floor). Total.
  defp install_from_data do
    source =
      case File.read(@sources_path) do
        {:ok, s} -> s
        _ -> @sources_source
      end

    with true <- is_binary(source) and source != "",
         {:ok, _step} <-
           PtcRunner.Lisp.run(source,
             tools: DataSource.Verb.tools(),
             caller: :in_process_v1
           ),
         true <- @source_name in DataSource.Registry.names() do
      :ok
    else
      _ -> :error
    end
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  # The compiled floor: register the Elixir `sessions/1` closure (the M0 interim
  # producer) so `data/sessions` still resolves when the `.ptc` authoring is
  # missing/broken. Never-brick: the feature survives a bad data file.
  defp install_fallback do
    DataSource.Registry.register(@source_name, fn ctx ->
      sessions(Map.get(ctx, :hist_store))
    end)
  end

  @doc """
  Install the cockpit's navigation reactions (PLAN-027 M6): run
  `cockpit_reactions.ptc`, which registers the drill/back reactions (authored as
  `keymap/define-reaction` returning effect envelopes). Idempotent + best-effort:
  a missing/malformed file or an absent registry is a no-op, never raises. Bind a
  key to `cockpit/drill` / `cockpit/back` (via `keymap/bind`) to drive them.
  """
  @spec install_reactions() :: :ok
  def install_reactions do
    source =
      case File.read(@reactions_path) do
        {:ok, s} -> s
        _ -> @reactions_source
      end

    if is_binary(source) and source != "" do
      # `keymap/define-reaction` lives in the harness tool tier (built per-render
      # from forest + gaze), NOT the base tools map — supply an empty forest + a
      # default gaze so the declaration verb is reachable at install time.
      tools = SpellAgent.Harness.tools(%{}, SpellAgent.Tui.Ui.new())

      PtcRunner.Lisp.run(source, tools: tools, caller: :in_process_v1)
    end

    :ok
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  @doc """
  Enter the cockpit (PLAN-027 M6): run `cockpit_layout.ptc` to shadow the `body`
  slot with the live per-session card grid.

  Returns `:ok` when the body slot was shadowed, `{:error, reason}` otherwise
  (the layout program failed, or `layout/set` rejected the node — e.g. the
  registry is unseeded/not-adoptable in a degraded state). Total + best-effort:
  a failure leaves the current layout untouched (the inspector stays), never
  crashes. `layout/reset` returns to the default inspector.
  """
  @spec show() :: :ok | {:error, term()}
  def show do
    source =
      case File.read(@layout_path) do
        {:ok, s} -> s
        _ -> @layout_source
      end

    with true <- is_binary(source) and source != "",
         {:ok, step} <-
           PtcRunner.Lisp.run(source,
             tools: SpellAgent.Tools.freeform_tools(),
             caller: :in_process_v1
           ),
         %{"ok" => true} <- step.return do
      :ok
    else
      %{"err" => reason} -> {:error, reason}
      {:error, step} -> {:error, Map.get(step, :fail, :cockpit_layout_failed)}
      _ -> {:error, :cockpit_layout_failed}
    end
  rescue
    e -> {:error, e}
  catch
    _, v -> {:error, v}
  end

  @doc """
  The cockpit's `data/sessions` binding: the live sessions, newest-first, each a
  string-keyed row of meta ⋈ content summary.

  Total and best-effort: an absent/sick registry yields `[]`; a per-session
  content read that fails yields a minimal row for THAT session (the others are
  unaffected). Never raises.

  `store` is the Hist store module/impl the sessions were recorded into (the App's
  `:hist_store`), used to read each session's trace cross-session.
  """
  @spec sessions(term()) :: [row()]
  def sessions(store) do
    # The compiled floor unions the SAME two source primitives the `.ptc` producer
    # uses (DataSource.Tools) — so the fallback shows exactly what the data path
    # does: the recorded sessions (finished + running) enriched with live lineage,
    # each merged with its bounded content summary. ONE union implementation, no
    # drift between the data producer and its Elixir floor.
    tier = DataSource.Tools.read_only(%{hist_store: store})
    lineage_fn = Map.fetch!(tier, "session-registry/lineage")
    summary_fn = Map.fetch!(tier, "hist/trace-summary")

    lineage_fn.(%{})
    |> Enum.take(@max_sessions)
    |> Enum.map(fn row -> Map.merge(row, summary_fn.(%{"id" => row["id"]})) end)
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  # NB: the per-session union + summarization that used to live here moved to
  # `SpellAgent.Tui.DataSource.Tools` (the read-only source tier the `.ptc`
  # producer calls), so there is now ONE implementation shared by the data path
  # and this Elixir floor — no drift. `sessions/1` above composes those two
  # primitives exactly as `cockpit_sources.ptc` does.
end
