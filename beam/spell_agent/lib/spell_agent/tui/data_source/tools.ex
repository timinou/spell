defmodule SpellAgent.Tui.DataSource.Tools do
  @moduledoc """
  The read-only capability tier a QUERY-CLOCK data-source producer runs in
  (PLAN-027 M1, FUP-036) — the sibling of `SpellAgent.Tui.Cell.Tools`.

  ## Why this exists

  M0 registered a data source as an Elixir closure (`Cockpit.sessions/1`) — the
  body still NAMED the feature. M1 dissolves that: a producer is a FROZEN PTC
  program the mind authors (`data-source/register`), evaluated on the query clock
  via `SpellAgent.Tui.Cell.resolve/3` (the exact off-frame sandbox cells use).
  This module is the one place that decides which verbs such a program may reach.

  ## Fail-closed allowlist (security is load-bearing — mirrors Cell.Tools)

  A data-source producer runs on the query clock reading cross-session state; it
  must be able to READ (the live session lineage, a session's conversation
  summary) and NOTHING that mutates. The policy is a fail-CLOSED ALLOWLIST: a
  verb reaches a producer ONLY if it is in `@source_verbs`. A new read verb is a
  deliberate edit here; a new mutator is invisible for free (never added). The
  `@forbidden` set is asserted disjoint at compile time as defense in depth.

  ## The two source primitives

    * `session-registry/lineage {}` → the live sessions' lineage rows
      (`id`/`owner`/`parent-id`/`intent`/`region`/`status`), string-keyed — the
      raw ancestry a cockpit overview projects. Bounded to the live set the
      registry already caps.

    * `hist/trace-summary {id}` → ONE session's bounded content summary
      (`turns`/`cost`/`running?`/`last`/`spans`) read from the Hist store. This
      is the per-session half the M0 Elixir `Cockpit.decorate/2` did, extracted
      as a primitive over a SINGLE session so the UNION (lineage ⋈ per-session
      summary) can be authored in PTC instead of Elixir. Bounded: `@summary_turns`
      spans per card; a missing/unreadable session degrades to a zeroed summary.

  The store the summary reads is closed over from the query-clock context
  (`:hist_store`), the same way `Cell.Tools.read_only/2` closes over the forest.

  ## Never-brick

  Every verb is total: a down registry yields `[]`; an unreadable session yields
  a zeroed summary; a nil store yields the unavailable summary. A producer that
  calls an unlisted verb gets `:error` (unknown tool) and the whole producer
  degrades at the `Cell.resolve` boundary — never a crash.
  """

  alias SpellAgent.SessionRegistry
  alias SpellAgent.Hist.Trace

  # Per-session span cap in a summary — a card is a glance, not a transcript
  # (mirrors Cockpit's @snapshot_turns; the drill-in shows the full inspector).
  @summary_turns 3

  # Fail-closed allowlist of read-only verbs a data-source producer may call.
  # Adding a new read verb means adding it HERE (deliberate; inert until vetted).
  @source_verbs MapSet.new(~w(
    session-registry/lineage
    hist/trace-summary
  ))

  # Provably-mutating verbs, asserted ABSENT from the allowlist (defense in depth,
  # spanning every mutating namespace a producer could be mis-granted). Pinned
  # disjoint at compile time below.
  @forbidden MapSet.new(~w(
    keymap/bind
    keymap/define-reaction
    hist/promote
    hist/crystallize
    define-tool
    define-config
    sh
    layout/set
    theme/set
    data-source/register
    data-source/remove
  ))

  @disjoint MapSet.intersection(@source_verbs, @forbidden)
  if MapSet.size(@disjoint) > 0 do
    raise CompileError,
      description:
        "DataSource.Tools allowlist contains forbidden mutators: " <>
          "#{inspect(MapSet.to_list(@disjoint))}"
  end

  @typedoc "A read-only tools map (verb name -> arity-1 callable)."
  @type t :: %{optional(String.t()) => (map() -> term())}

  @doc """
  Build the read-only tools tier a data-source producer runs against, reading
  from the query-clock context `ctx` (needs `:hist_store` for `hist/trace-summary`).

  Only the vetted `@source_verbs` are present; a producer that calls anything
  else degrades to `:error` at the `Cell.resolve` boundary. Total.
  """
  @spec read_only(map()) :: t()
  def read_only(ctx) when is_map(ctx) do
    store = Map.get(ctx, :hist_store)

    %{
      "session-registry/lineage" => fn _args -> lineage() end,
      "hist/trace-summary" => fn args -> trace_summary(store, args) end
    }
  end

  def read_only(_), do: %{}

  @doc "Whether `name` is a vetted read-only source verb."
  @spec allowed?(String.t()) :: boolean()
  def allowed?(name) when is_binary(name), do: MapSet.member?(@source_verbs, name)
  def allowed?(_), do: false

  @doc "The vetted read-only source-verb allowlist (tests + introspection)."
  @spec source_verbs() :: MapSet.t()
  def source_verbs, do: @source_verbs

  @doc "The known-mutator denylist (tests + introspection)."
  @spec forbidden_verbs() :: MapSet.t()
  def forbidden_verbs, do: @forbidden

  @doc "The per-session span cap in a summary."
  @spec summary_turns() :: pos_integer()
  def summary_turns, do: @summary_turns

  # ---- session-registry/lineage ----

  # The live lineage rows, string-keyed for PTC. Best-effort: a down registry
  # yields []. Owner is stringified (`:human` / `{:session, parent}` -> "human" /
  # "session:parent") so the producer sees plain strings.
  defp lineage do
    SessionRegistry.lineage()
    |> Enum.map(fn row ->
      %{
        "id" => Map.get(row, :session_id),
        "owner" => owner_string(Map.get(row, :owner)),
        "parent-id" => Map.get(row, :parent_id),
        "intent" => Map.get(row, :intent),
        "region" => Map.get(row, :region),
        "status" => status_string(Map.get(row, :status))
      }
    end)
  rescue
    _ -> []
  catch
    _, _ -> []
  end

  # ---- hist/trace-summary ----

  # One session's bounded content summary from the Hist store. Total: a nil
  # store, unknown id, or a read failure degrades to a zeroed/unavailable summary
  # (the SAME never-brick posture Cockpit.decorate had), never a raise.
  defp trace_summary(store, args) when is_map(args) do
    id = Map.get(args, "id")
    summarize(safe_rows(store, id))
  rescue
    _ -> unavailable()
  catch
    _, _ -> unavailable()
  end

  defp trace_summary(_store, _args), do: unavailable()

  defp safe_rows(nil, _id), do: []
  defp safe_rows(_store, id) when not is_binary(id), do: []
  defp safe_rows(store, id), do: Trace.rows(store, id)

  defp summarize(rows) when is_list(rows) do
    %{
      "turns" => length(rows),
      "cost" => total_tokens(rows),
      "running?" => running?(rows),
      "last" => last_activity(rows),
      "spans" => rows |> Enum.take(-@summary_turns) |> Enum.map(&span_row/1)
    }
  end

  defp unavailable do
    %{"turns" => 0, "cost" => 0, "running?" => false, "last" => "(snapshot unavailable)", "spans" => []}
  end

  defp total_tokens(rows) do
    Enum.reduce(rows, 0, fn row, acc ->
      case Map.get(row, :tokens) do
        %{input: i, output: o} when is_integer(i) and is_integer(o) -> acc + i + o
        _ -> acc
      end
    end)
  end

  defp running?([]), do: false

  defp running?(rows) do
    case List.last(rows) do
      %{status: s} -> s not in [:ok, :error, "ok", "error"]
      _ -> false
    end
  end

  defp last_activity([]), do: "(no activity yet)"

  defp last_activity(rows) do
    case List.last(rows) do
      %{} = row -> row |> salient_text() |> oneline(70)
      _ -> "(no activity yet)"
    end
  end

  defp salient_text(%{say: s}) when is_binary(s) and s != "", do: s
  defp salient_text(%{prompt: p}) when is_binary(p) and p != "", do: p
  defp salient_text(%{form_src: f}) when is_binary(f) and f != "", do: f
  defp salient_text(%{result: r}) when not is_nil(r), do: glimpse(r)
  defp salient_text(_), do: "(working…)"

  defp glimpse(r) when is_binary(r), do: r
  defp glimpse(r), do: inspect(r)

  defp span_row(row) do
    %{
      "seq" => Map.get(row, :seq),
      "status" => span_status(Map.get(row, :status)),
      "title" => row |> salient_text() |> oneline(48)
    }
  end

  # ---- coercions ----

  defp owner_string(:human), do: "human"
  defp owner_string({:session, p}) when is_binary(p), do: "session:" <> p
  defp owner_string(nil), do: "human"
  defp owner_string(other), do: inspect(other)

  defp status_string(s) when is_atom(s) and not is_nil(s), do: Atom.to_string(s)
  defp status_string(s) when is_binary(s), do: s
  defp status_string(_), do: "running"

  defp span_status(s) when s in [:ok, "ok"], do: "ok"
  defp span_status(s) when s in [:error, "error"], do: "error"
  defp span_status(_), do: "running"

  defp oneline(s, n) when is_binary(s) do
    s |> String.replace(~r/\s+/u, " ") |> String.trim() |> truncate(n)
  end

  defp oneline(other, n), do: oneline(inspect(other), n)

  defp truncate(s, n) when byte_size(s) <= n, do: s
  defp truncate(s, n), do: String.slice(s, 0, max(n - 1, 0)) <> "…"
end
