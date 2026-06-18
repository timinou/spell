defmodule SpellAgent.Tui.Store do
  @moduledoc """
  Live span forest — the single source of truth for the inspector TUI (PLAN-345).

  Attaches to `PtcRunner.SubAgent` telemetry and reduces the event stream into a
  forest of `SpellAgent.Tui.Store.Span` nodes, keyed by `span_id` and linked by
  `parent_span_id`. This forest IS the model's interior: a `:run` contains `:llm`
  and `:tool` spans, and a `:tool` whose implementation is itself a sub-agent
  contains a nested `:run` — so drilling the forest is drilling "inside the
  insides".

  ## Event handling

  PtcRunner emits two shapes (verified in
  `ptc_runner/sub_agent/telemetry.ex` + `loop.ex`):

    * SPANS — `:run`, `:llm`, `:tool` — via `Telemetry.span`, each with its own
      `span_id` and a `parent_span_id`. `:start` opens a node; `:stop` closes it
      (sets `t1`, `status`, merges stop meta); `:exception` marks it `:error`.
    * TURN EMITS — `[:turn, :start|:stop]` via `Telemetry.emit`, carrying the
      *owning run's* `span_id` (NOT a new span) plus a `:turn` integer. These are
      folded onto the run span's `turns` list, not turned into nodes.

  After every event the store broadcasts `{:store_updated, suffix}` (e.g.
  `{:turn, :stop}`) to subscribers, so a pane can wake only on the suffixes it
  declares (`SpellAgent.Tui.Pane.events/0`). This is the dirty-filter behind
  `SpellAgent.Tui.Projection`.

  Subscription is in-process pub/sub over a `MapSet` of pids — no external
  PubSub dep. `subscribe/0` from the App; the store monitors and drops dead pids.
  """

  use GenServer

  alias SpellAgent.Tui.Store.Span

  @prefix [:ptc_runner, :sub_agent]
  @span_kinds [:run, :llm, :tool]

  # ---- client ----

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc "Subscribe the calling process to `{:store_updated, suffix}` broadcasts."
  @spec subscribe(GenServer.server()) :: :ok
  def subscribe(server \\ __MODULE__), do: GenServer.call(server, {:subscribe, self()})

  @doc "The whole forest as a `%{span_id => Span.t()}` map."
  @spec spans(GenServer.server()) :: %{optional(String.t()) => Span.t()}
  def spans(server \\ __MODULE__), do: GenServer.call(server, :spans)

  @doc "Root span ids (parent_id == nil), oldest first."
  @spec roots(GenServer.server()) :: [String.t()]
  def roots(server \\ __MODULE__), do: GenServer.call(server, :roots)

  @doc "Reset the forest (e.g. between missions). Subscriptions are kept."
  @spec reset(GenServer.server()) :: :ok
  def reset(server \\ __MODULE__), do: GenServer.call(server, :reset)

  @doc """
  Attach this store to the global telemetry bus. Idempotent per handler id.

  Returns the handler id, which is also detached on store termination.
  """
  @spec attach(GenServer.server()) :: :ok
  def attach(server \\ __MODULE__), do: GenServer.call(server, :attach)

  # ---- forest accessors (pure; operate on a spans map) ----

  @doc "Direct children of `id`, oldest first (by insertion order in the parent)."
  @spec children(map(), String.t()) :: [Span.t()]
  def children(spans, id) do
    case spans[id] do
      %Span{children: ids} -> ids |> Enum.reverse() |> Enum.map(&spans[&1]) |> Enum.reject(&is_nil/1)
      _ -> []
    end
  end

  @doc "All run spans in the forest, oldest first."
  @spec run_spans(map()) :: [Span.t()]
  def run_spans(spans), do: spans |> Map.values() |> Enum.filter(&(&1.kind == :run)) |> sort()

  @doc "All tool spans in the forest, oldest first."
  @spec tool_spans(map()) :: [Span.t()]
  def tool_spans(spans), do: spans |> Map.values() |> Enum.filter(&(&1.kind == :tool)) |> sort()

  @doc "The subtree rooted at `id`, depth-first, as a flat list (root first)."
  @spec subtree(map(), String.t()) :: [Span.t()]
  def subtree(spans, id) do
    case spans[id] do
      nil -> []
      %Span{} = node -> [node | Enum.flat_map(children(spans, id), &subtree(spans, &1.id))]
    end
  end
  @doc """
  Root span ids from a forest MAP (pure; for use inside `project/2`), oldest
  first. A root has `parent_id == nil`, or a `parent_id` not present in the map
  (an ancestor span we never saw, e.g. a non-sub_agent wrapper).
  """
  @spec roots_from(map()) :: [Span.t()]
  def roots_from(spans) do
    spans
    |> Map.values()
    |> Enum.filter(fn %Span{parent_id: p} -> is_nil(p) or not Map.has_key?(spans, p) end)
    |> sort()
  end
  defp sort(list), do: Enum.sort_by(list, & &1.t0)

  # ---- telemetry handler (runs in the emitting process; just casts) ----

  @doc false
  def handle_telemetry(event, measurements, metadata, %{pid: pid}) do
    suffix = event |> Enum.drop(length(@prefix))
    GenServer.cast(pid, {:telemetry, suffix, measurements, metadata})
  end

  # ---- server ----

  @impl true
  def init(_opts) do
    {:ok, %{spans: %{}, roots: [], subscribers: MapSet.new(), handler_id: nil}}
  end

  @impl true
  def handle_call({:subscribe, pid}, _from, state) do
    Process.monitor(pid)
    {:reply, :ok, %{state | subscribers: MapSet.put(state.subscribers, pid)}}
  end

  def handle_call(:spans, _from, state), do: {:reply, state.spans, state}
  def handle_call(:roots, _from, state), do: {:reply, Enum.reverse(state.roots), state}

  def handle_call(:reset, _from, state), do: {:reply, :ok, %{state | spans: %{}, roots: []}}

  def handle_call(:attach, _from, %{handler_id: id} = state) when is_binary(id) do
    {:reply, :ok, state}
  end

  def handle_call(:attach, _from, state) do
    id = "spell-tui-store-#{:erlang.phash2(self())}"

    events =
      for kind <- @span_kinds, phase <- [:start, :stop, :exception], do: @prefix ++ [kind, phase]

    events = events ++ [@prefix ++ [:turn, :start], @prefix ++ [:turn, :stop]]

    :ok = :telemetry.attach_many(id, events, &__MODULE__.handle_telemetry/4, %{pid: self()})
    {:reply, :ok, %{state | handler_id: id}}
  end

  @impl true
  def handle_cast({:telemetry, suffix, measurements, metadata}, state) do
    state = apply_event(state, suffix, measurements, metadata)
    broadcast(state.subscribers, suffix)
    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    {:noreply, %{state | subscribers: MapSet.delete(state.subscribers, pid)}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{handler_id: id}) when is_binary(id) do
    :telemetry.detach(id)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  # ---- event reduction ----

  # Turn emits carry the owning run's span_id; fold onto that run span.
  defp apply_event(state, [:turn, phase], _meas, meta) do
    run_id = meta[:span_id]

    case state.spans[run_id] do
      %Span{kind: :run} = run ->
        put_in(state.spans[run_id], merge_turn(run, phase, meta))

      _ ->
        state
    end
  end

  # Span start: open a node, link to parent, register as root or child.
  defp apply_event(state, [kind, :start], _meas, meta) when kind in @span_kinds do
    do_span_start(state, kind, meta[:span_id], meta[:parent_span_id], meta)
  end

  # Span stop: close the node, merge stop metadata + token measurements, set status.
  defp apply_event(state, [kind, :stop], meas, meta) when kind in @span_kinds do
    close(state, meta[:span_id], status_from(meta), meta, meas)
  end

  # Span exception: close as error.
  defp apply_event(state, [kind, :exception], meas, meta) when kind in @span_kinds do
    close(state, meta[:span_id], :error, meta, meas)
  end

  defp apply_event(state, _suffix, _meas, _meta), do: state

  # Malformed start: no span_id means we can't key a node — ignore it rather than
  # create a phantom nil-keyed span (defends against malformed telemetry).
  defp do_span_start(state, _kind, nil, _parent_id, _meta), do: state

  defp do_span_start(state, kind, id, parent_id, meta) do
    span = %Span{
      id: id,
      parent_id: parent_id,
      kind: kind,
      status: :running,
      label: label_for(kind, meta),
      t0: System.monotonic_time(),
      meta: strip(meta)
    }

    spans = Map.put(state.spans, id, span)
    {spans, roots} = link_parent(spans, state.roots, id, parent_id)
    %{state | spans: spans, roots: roots}
  end

  defp link_parent(spans, roots, id, nil), do: {spans, [id | roots]}

  defp link_parent(spans, roots, id, parent_id) do
    case spans[parent_id] do
      %Span{} = parent ->
        {Map.put(spans, parent_id, %{parent | children: [id | parent.children]}), roots}

      # Parent not seen (e.g. a non-sub_agent ancestor span). Treat as a root so
      # the node is still visible rather than orphaned.
      nil ->
        {spans, [id | roots]}
    end
  end

  defp close(state, nil, _status, _meta, _meas), do: state

  defp close(state, id, status, meta, meas) do
    case state.spans[id] do
      %Span{} = span ->
        merged_meta = Map.merge(span.meta, strip(meta))

        closed = %{
          span
          | status: status,
            t1: System.monotonic_time(),
            meta: merged_meta,
            tokens: tokens_from(meas)
        }

        %{state | spans: Map.put(state.spans, id, %{closed | label: label_for(span.kind, merged_meta, closed)})}

      nil ->
        state
    end
  end

  # Token tallies live in telemetry MEASUREMENTS, not metadata. Keep the useful
  # keys; nil when the event carried none (e.g. a start, or a tool call).
  defp tokens_from(meas) when is_map(meas) do
    picked =
      meas
      |> Map.take([:tokens, :input_tokens, :output_tokens])
      |> Enum.into(%{}, fn
        {:input_tokens, v} -> {:input, v}
        {:output_tokens, v} -> {:output, v}
        {k, v} -> {k, v}
      end)

    if map_size(picked) == 0, do: nil, else: picked
  end

  defp tokens_from(_), do: nil

  defp merge_turn(%Span{turns: turns} = run, phase, meta) do
    incoming = %{
      number: meta[:turn],
      program: meta[:program],
      result_preview: meta[:result_preview],
      response: meta[:raw_response] || meta[:response],
      status: if(phase == :stop, do: :ok, else: :running)
    }

    %{run | turns: upsert_turn(turns, incoming)}
  end

  # Merge into the turn with the same number (start sets program; stop adds the
  # result — non-nil incoming fields win, so neither phase clobbers the other),
  # else append; keep ordered by number.
  defp upsert_turn(turns, %{number: n} = incoming) do
    {merged, hit?} =
      Enum.map_reduce(turns, false, fn
        %{number: ^n} = old, _ -> {merge_turn_fields(old, incoming), true}
        other, hit -> {other, hit}
      end)

    if hit?, do: merged, else: Enum.sort_by(merged ++ [incoming], &(&1.number || 0))
  end

  # Field-wise merge: a non-nil incoming value overwrites; nil leaves the prior.
  # Status always advances to the incoming phase (running → ok).
  defp merge_turn_fields(old, incoming) do
    Map.merge(old, incoming, fn
      :status, _o, n -> n
      _k, o, nil -> o
      _k, _o, n -> n
    end)
  end

  defp status_from(meta) do
    case meta[:status] do
      :ok -> :ok
      :error -> :error
      _ -> :ok
    end
  end

  # Label at START — only metadata is known yet (no tokens, no result).
  defp label_for(kind, meta), do: label_for(kind, meta, nil)

  # Label at STOP — enrich with tokens (llm/run) and the result (tool).
  defp label_for(:run, meta, span) do
    name = printable(meta[:agent_name])
    join(["run", name, tok(span)])
  end

  # NB: llm metadata's `:model` is the llm CALLBACK fn, not a model name — never
  # render it. Show the token cost instead, which is what's actually useful.
  defp label_for(:llm, _meta, span) do
    join(["llm", tok(span) || "…"])
  end

  defp label_for(:tool, meta, _span) do
    name = printable(meta[:tool_name])
    detail = result_or_args(meta)
    join(["tool", name, detail])
  end

  # Prefer the result (set at stop) over the args (set at start) for the inline
  # one-liner; both are already summarized by PtcRunner.
  defp result_or_args(meta) do
    cond do
      meta[:result] != nil -> "→ " <> clip(printable(meta[:result]), 48)
      meta[:args] not in [nil, %{}] -> clip(printable(meta[:args]), 48)
      true -> nil
    end
  end

  # Compact token suffix, e.g. "1.2k tok" or "312→88".
  defp tok(%Span{tokens: %{input: i, output: o}}) when is_integer(i) and is_integer(o),
    do: "#{i}→#{o} tok"

  defp tok(%Span{tokens: %{tokens: t}}) when is_integer(t), do: "#{t} tok"
  defp tok(_), do: nil

  defp join(parts), do: parts |> Enum.reject(&(&1 in [nil, ""])) |> Enum.join("  ")

  defp clip(s, n) when is_binary(s) do
    flat = s |> String.replace(~r/\s+/, " ") |> String.trim()
    if String.length(flat) > n, do: String.slice(flat, 0, n - 1) <> "…", else: flat
  end

  # Telemetry metadata values are arbitrary terms (e.g. a summarized result map).
  # Render anything to a short, safe string; NEVER leak a raw function.
  defp printable(nil), do: ""
  defp printable(s) when is_binary(s), do: s
  defp printable(a) when is_atom(a), do: Atom.to_string(a)
  defp printable(f) when is_function(f), do: ""
  defp printable(other), do: inspect(other, limit: 6, printable_limit: 200)

  # Drop internal span-correlation keys + the bulky `agent` struct from stored
  # metadata; everything else (program, result, args, response, turn, …) stays.
  @stripped [:span_id, :parent_span_id, :telemetry_span_context, :agent]
  defp strip(meta), do: Map.drop(meta, @stripped)

  defp broadcast(subscribers, suffix) do
    for pid <- subscribers, do: send(pid, {:store_updated, suffix})
    :ok
  end
end
