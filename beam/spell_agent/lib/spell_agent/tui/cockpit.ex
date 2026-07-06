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

  alias SpellAgent.SessionRegistry
  alias SpellAgent.Hist.Trace
  alias SpellAgent.Tui.DataSource

  # The `data/*` binding this source produces. The layout reads `data/sessions`.
  @source_name "sessions"

  # The grid is bounded: at most this many session cards. A hard floor on both the
  # render cost (N panes) and the atom/term cost of the projected data. Sessions
  # beyond this are not shown in the overview (newest-first from the registry).
  @max_sessions 12

  # Per card, only the last-N turns are carried into the overview — a card is a
  # glance, not a transcript. Drill-in (a lens op) shows the full inspector.
  @snapshot_turns 3

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
  Register the cockpit as ONE query-clock data source (PLAN-027 M0).

  This is the PERIPHERY policy call — the one place that says "`data/sessions` is
  produced by the cockpit materializer". The render loop (`App.reproject`) never
  names this source; it resolves whatever is registered. The producer closes over
  `sessions/1`, reading the `:hist_store` from the query-clock context the App
  hands every source. Best-effort: a no-op if the registry is absent (headless).

  M1 (FUP-036) dissolves even this Elixir producer into a frozen `.ptc` program;
  until then this interim registration keeps the render loop feature-agnostic
  while the materializer is still Elixir.
  """
  @spec install() :: :ok | {:error, String.t()}
  def install do
    DataSource.Registry.register(@source_name, fn ctx ->
      sessions(Map.get(ctx, :hist_store))
    end)
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
    SessionRegistry.lineage()
    |> Enum.take(@max_sessions)
    |> Enum.map(&decorate(&1, store))
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  # ---- per-session union (best-effort, isolated) ----

  # Union one session's live meta with its content summary. Wrapped so a single
  # failing session degrades to a minimal card carrying just its meta — the OTHER
  # cards are never lost to one sick session (the per-row failure ladder).
  defp decorate(meta, store) do
    base = meta_row(meta)

    content =
      try do
        summarize(safe_rows(store, meta.session_id))
      rescue
        _ -> unavailable()
      catch
        :exit, _ -> unavailable()
      end

    Map.merge(base, content)
  end

  # The always-present meta half, string-keyed for PTC. Never touches the store.
  defp meta_row(meta) do
    %{
      "id" => Map.get(meta, :session_id),
      "owner" => owner_string(Map.get(meta, :owner)),
      "parent-id" => Map.get(meta, :parent_id),
      "intent" => Map.get(meta, :intent),
      "region" => Map.get(meta, :region),
      "status" => status_string(Map.get(meta, :status))
    }
  end

  # ---- content summary from the conversation trace ----

  defp summarize(rows) when is_list(rows) do
    %{
      "turns" => length(rows),
      "cost" => total_tokens(rows),
      "running?" => running?(rows),
      "last" => last_activity(rows),
      "spans" => rows |> Enum.take(-@snapshot_turns) |> Enum.map(&span_row/1)
    }
  end

  # The content half when this session's trace could not be read.
  defp unavailable do
    %{
      "turns" => 0,
      "cost" => 0,
      "running?" => false,
      "last" => "(snapshot unavailable)",
      "spans" => []
    }
  end

  defp safe_rows(store, session_id) when is_binary(session_id) do
    Trace.rows(store, session_id)
  end

  defp safe_rows(_store, _sid), do: []

  # Sum input + output tokens across every turn that recorded them. A turn with
  # nil tokens contributes zero — a running session's latest turn often has none
  # yet, which must not crash the sum.
  defp total_tokens(rows) do
    Enum.reduce(rows, 0, fn row, acc ->
      case Map.get(row, :tokens) do
        %{input: i, output: o} when is_integer(i) and is_integer(o) -> acc + i + o
        _ -> acc
      end
    end)
  end

  # A session is "running" if its most recent turn is still pending (no terminal
  # status). Best-effort: an empty trace is not running.
  defp running?([]), do: false

  defp running?(rows) do
    case List.last(rows) do
      %{status: status} -> status not in [:ok, :error, "ok", "error"]
      _ -> false
    end
  end

  # A one-line "what this session is doing now" — the last turn's most salient
  # text: its assistant say, else its prompt, else a result glimpse.
  defp last_activity([]), do: "(no activity yet)"

  defp last_activity(rows) do
    case List.last(rows) do
      %{} = row -> row |> salient_text() |> oneline(70)
      _ -> "(no activity yet)"
    end
  end

  defp salient_text(%{say: say}) when is_binary(say) and say != "", do: say
  defp salient_text(%{prompt: p}) when is_binary(p) and p != "", do: p
  defp salient_text(%{form_src: f}) when is_binary(f) and f != "", do: f
  defp salient_text(%{result: r}) when not is_nil(r), do: result_glimpse(r)
  defp salient_text(_), do: "(working…)"

  defp result_glimpse(r) when is_binary(r), do: r
  defp result_glimpse(r), do: inspect(r)

  # One span row for a card line: sequence, status glyph key, and a one-line title.
  defp span_row(row) do
    %{
      "seq" => Map.get(row, :seq),
      "status" => span_status(Map.get(row, :status)),
      "title" => row |> salient_text() |> oneline(48)
    }
  end

  # ---- coercions (bounded, PTC-safe strings) ----

  defp owner_string(:human), do: "human"
  defp owner_string({:session, parent}) when is_binary(parent), do: "session:" <> parent
  defp owner_string(nil), do: "human"
  defp owner_string(other), do: inspect(other)

  defp status_string(s) when is_atom(s) and not is_nil(s), do: Atom.to_string(s)
  defp status_string(s) when is_binary(s), do: s
  defp status_string(_), do: "running"

  defp span_status(s) when s in [:ok, "ok"], do: "ok"
  defp span_status(s) when s in [:error, "error"], do: "error"
  defp span_status(_), do: "running"

  defp oneline(s, n) when is_binary(s) do
    s
    |> String.replace(~r/\s+/u, " ")
    |> String.trim()
    |> truncate(n)
  end

  defp oneline(other, n), do: oneline(inspect(other), n)

  defp truncate(s, n) when byte_size(s) <= n, do: s
  defp truncate(s, n), do: String.slice(s, 0, max(n - 1, 0)) <> "…"
end
