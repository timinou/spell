defmodule PtcRuntime.Peer do
  @moduledoc """
  Bidirectional JSON-RPC 2.0 peer (NDJSON framing) — the Node ↔ BEAM transport.

  ## Wire protocol

  One JSON object per line (newline-delimited). Two frame shapes, split by
  structure (never by id-space, so the two directions can never collide):

    * **Request** — has a `"method"`. Either side may send one.
      `{"jsonrpc":"2.0","id":<int>,"method":<string>,"params":<obj>}`
    * **Response** — has `"result"` or `"error"`, no `"method"`. Replies to a
      request with the matching `id`.
      `{"jsonrpc":"2.0","id":<int>,"result":<any>}`
      `{"jsonrpc":"2.0","id":<int>,"error":{"code":<int>,"message":<str>}}`

  ### Node → BEAM requests
    * `init`    — `{catalog: {...}}` hydrate the runtime; reply `{ok: true,...}`.
    * `execute` — `{program, context?, signature?, timeout_ms?}` run a PTC-Lisp
                  program; reply with the (signature-validated) return value or
                  an error describing the sandbox failure.

  ### BEAM → Node requests (reentrant, issued *during* an `execute`)
    * `tool_call` — `{tool, args}` a running program reached a `(tool/...)`
                    form; Node services it against the real executor and
                    responds. The response IS the "tool_result". Many may be in
                    flight at once (pmap fan-out).

  ## Concurrency model (load-bearing)

  `PtcRunner.Lisp.run/2` blocks its caller while the program runs in a spawned
  sandbox process; tool functions execute *inside* that sandbox (and inside
  `pmap` workers). Therefore:

    * `execute` runs in a spawned process so the Peer keeps servicing frames —
      critically, the `tool_call` *responses* that unblock tool callbacks.
    * A tool callback calls `tool_call/3`, a `GenServer.call` whose reply the
      Peer **defers** (`{:noreply, …}` + stored `from`) until the matching
      response frame arrives. This blocks the *worker*, not the Peer.
    * All stdout writes funnel through the Peer process, so concurrent
      `tool_call` frames never interleave on the wire.

  ## stderr hazard

  Protocol frames are written ONLY to the configured `writer` (stdout in
  production). Diagnostics go through `Logger` (→ file, see
  `PtcRuntime.Logger`). Nothing here writes to `:standard_error`.

  ## Testability

  The Peer takes an injectable `:writer` (`(iodata -> :ok)`) and is fed inbound
  frames as `{:frame, binary}` messages. Tests supply a writer that forwards to
  the test process and play the reader role — no real stdio needed. In
  production (`autostart: true`) a linked reader pumps `:stdio`.
  """
  use GenServer
  require Logger

  alias PtcRunner.Lisp.HandleStore
  alias PtcRuntime.Bridge

  @type writer :: (iodata() -> :ok)

  # JSON-RPC error codes (-32xxx reserved by spec; -320xx = our domain).
  @code_parse_error -32_700
  @code_invalid_request -32_600
  @code_method_not_found -32_601
  @code_internal_error -32_603
  @code_not_initialized -32_001
  @code_execute_failed -32_002
  @code_capacity_exceeded -32_004

  # Default ceiling on executes running concurrently on this one runtime
  # (PLAN-323). Each execute can spawn up to `max_parallel_workers` pmap workers
  # at ~`worker_max_heap` each, so unbounded concurrency is an OOM vector. The
  # ceiling bounds aggregate live heap to roughly
  # `max_concurrent_executes * max_parallel_workers * worker_max_heap`.
  @default_max_concurrent_executes 8


  # Default sandbox max heap in words (50 MB / 8 bytes-per-word).
  # Overridable per-session via the Peer start_link :max_heap opt, and
  # per-execute via the `max_heap` request param (FEAT-791) — clamped to
  # @max_heap_ceiling so a malformed frame can't exhaust the host.
  @default_max_heap 6_250_000
  # Absolute per-execute heap ceiling in words (256 MB / 8 bytes-per-word).
  @max_heap_ceiling 33_554_432
  # How long a single tool_call may wait for Node before the worker gives up.
  # Generous: Node may itself be doing slow IO (bash, network).
  @tool_call_timeout 120_000

  # SPELL PATCH-3 (D-2): a decoded tool result whose serialized size reaches
  # this many BYTES is PARKED in the HandleStore and replied as a small handle,
  # so it never copies onto the sandbox worker's heap. Measured with
  # `:erlang.external_size/1`, which counts off-heap binary payloads (string
  # bodies) — the BUG-426 dashboard is mostly those. Below the threshold the
  # result is replied verbatim (no handle ceremony for the common small case).
  @handle_park_bytes 262_144

  # SPELL PATCH-4 (D-6): the persistent HandleStore bucket for bound large
  # values. Never released by an execute teardown (those release a numeric
  # exec id); swept only at peer/BEAM exit. A bound handle re-homed here keeps
  # the D-2 offload benefit across executes instead of being realized into a
  # compile-heap-blowing term.
  @session_bucket :__session_bindings__

  defmodule State do
    @moduledoc false
    @enforce_keys [:writer]
    defstruct writer: nil,
              initialized: false,
              catalog: nil,
              tools: %{},
              # outbound tool_call id → {from, caller_monitor_ref}
              pending: %{},
              # caller monitor ref → tool_call id (reverse index for cleanup)
              callers: %{},
              next_id: 1,
              # execute procs in flight: monitor ref → request id
              tasks: %{},
              # PLAN-323 resource caps (nil → ptc_runner defaults), threaded into
              # every PtcRunner.Lisp.run; and the concurrent-execute admission ceiling.
              max_heap: nil,
              worker_max_heap: nil,
              max_parallel_workers: nil,
              max_concurrent_executes: nil,
              # SPELL PATCH-4 (D-6): session bindings. `(def x v)` in one execute
              # persists `v` here; the next execute resolves `x` from it. Reuses
              # ptc_runner's existing def→memory machinery rather than a parallel
              # `bind/` namespace. A cache, never durable truth: lost on respawn
              # (the agent re-binds by re-running). Values are realized (handles
              # are exec-scoped and released at teardown), so a bound value is
              # always a plain term.
              memory: %{}
  end

  # -------------------------------------------------------------------------
  # Public API
  # -------------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Issue a reentrant `tool_call` to Node and block until it responds.

  Called from inside a sandbox/pmap worker by the bridge tool function. Returns
  the tool's result value, or raises so the PTC-Lisp runtime surfaces a tool
  error (caught by the sandbox; never crashes the node).
  """
  @spec tool_call(GenServer.server(), String.t(), map(), term()) :: term()
  def tool_call(server \\ __MODULE__, tool, args, exec_id \\ nil)
      when is_binary(tool) and is_map(args) do
    case GenServer.call(server, {:tool_call, tool, args, exec_id}, @tool_call_timeout) do
      {:ok, value} -> value
      {:error, %{"message" => msg}} -> raise "tool #{tool} failed: #{msg}"
      {:error, other} -> raise "tool #{tool} failed: #{inspect(other)}"
    end
  end

  # -------------------------------------------------------------------------
  # GenServer
  # -------------------------------------------------------------------------

  @impl true
  def init(opts) do
    writer = Keyword.get(opts, :writer, &default_writer/1)
    autostart = Keyword.get(opts, :autostart, true)

    if autostart do
      # The stdio device defaults to `:unicode` when stdout is a pipe. In that
      # mode `IO.binwrite/2` (our frame writer) treats each byte of an already
      # UTF-8-encoded binary as a latin1 character and re-UTF-8-encodes it,
      # double-mangling every non-ASCII codepoint on the wire (BUG-464). The
      # protocol is a raw JSON *byte* stream — Jason owns UTF-8 at the JSON
      # layer — so put the device in `:latin1` (transparent bytes) and pump it
      # with `binread`/`binwrite` on both legs. ASCII frames are unaffected;
      # non-ASCII now round-trips byte-identical.
      :io.setopts(:standard_io, encoding: :latin1)
      start_reader(self())
    end

    {:ok,
     %State{
       writer: writer,
       max_heap: Keyword.get(opts, :max_heap, @default_max_heap),
       worker_max_heap: Keyword.get(opts, :worker_max_heap),
       max_parallel_workers: Keyword.get(opts, :max_parallel_workers),
       max_concurrent_executes:
         Keyword.get(opts, :max_concurrent_executes, @default_max_concurrent_executes)
     }}
  end

  @impl true
  def handle_call({:tool_call, tool, args, exec_id}, {caller_pid, _tag} = from, %State{} = st) do
    id = st.next_id

    # `exec_id` identifies the originating execute so Node can select the
    # correct per-execute abort signal (PLAN-324). Omitted when nil so the
    # wire stays clean for callers that don't carry one.
    call_params = %{"tool" => tool, "args" => args}

    call_params =
      if exec_id == nil, do: call_params, else: Map.put(call_params, "exec_id", exec_id)

    frame = %{
      "jsonrpc" => "2.0",
      "id" => id,
      "method" => "tool_call",
      "params" => call_params
    }

    # A program can pass a non-encodable term as a tool arg, e.g.
    # `(tool/find {:f (fn [x] x)})`. Encoding the frame must NOT raise inside
    # this GenServer (it would crash the only long-lived process). `write/2` is
    # non-raising; on encode failure we reply to the worker with a tool error
    # and never touch the wire (Review Gate 1, P1 — symmetric to the
    # return-value guard).
    case write(st, frame) do
      :ok ->
        mref = Process.monitor(caller_pid)

        {:noreply,
         %{
           st
           | next_id: id + 1,
             # Carry `exec_id` (PATCH-3) so a parked response handle is filed
             # under the originating execute's GC bucket.
             pending: Map.put(st.pending, id, {from, mref, exec_id}),
             callers: Map.put(st.callers, mref, id)
         }}

      {:error, _} ->
        {:reply, {:error, %{"message" => "tool args are not serializable"}}, st}
    end
  end

  # Inbound frame from the reader (or a test).
  @impl true
  def handle_info({:frame, line}, %State{} = st) do
    case decode(line) do
      {:ok, msg} ->
        {:noreply, dispatch(msg, st)}

      {:error, reason} ->
        write(st, error_frame(nil, @code_parse_error, "parse error: #{reason}"))
        {:noreply, st}
    end
  end

  # EOF on stdin: Node closed the pipe. Shut down cleanly.
  def handle_info(:eof, %State{} = st) do
    Logger.info("PtcRuntime.Peer: stdin EOF, stopping")
    {:stop, :normal, st}
  end

  # An execute proc finished. Reply to its request id.
  def handle_info({:execute_done, id, result, memory}, %State{} = st) do
    case result do
      {:ok, value} ->
        write(st, result_frame(id, value))

      {:error, frame} ->
        write(st, error_frame(id, @code_execute_failed, frame.message, frame.data))
    end

    # SPELL PATCH-4 (D-6): persist this execute's bindings (`def`s) for the next
    # one. Only a successful, encodable run returns non-nil memory; a failed or
    # crashed program leaves bindings untouched. Capture happens in the
    # serialized GenServer, so concurrent executes can't interleave the merge.
    #
    # CRITICAL handle interaction: a `(def x (tool/big {}))` binds a HANDLE whose
    # term is released below at this execute's teardown — the next execute would
    # see a stale handle. We re-home such handles into a persistent session
    # bucket (@session_bucket, never released) so the binding stays a small
    # handle and the NEXT execute seeds it without copying a multi-MB term onto
    # the bounded compile heap (which would OOM the compile phase). A bound
    # large value thus keeps the D-2 offload benefit across executes.
    # MERGE (not replace) the new bindings into session memory: two concurrent
    # executes binding DIFFERENT names must both survive. The seed is a
    # snapshot at spawn, so the just-finished execute's `memory` already
    # contains the bindings it saw plus its own new ones; merging it over the
    # current `st.memory` keeps any binding a concurrently-completed execute
    # committed in between. Same-name conflicts resolve last-completed-wins.
    st =
      if is_map(memory),
        do: %{st | memory: Map.merge(st.memory, persist_bindings(memory))},
        else: st

    # SPELL PATCH-3 / W2b (D-2/D-7): record how much this execute offloaded —
    # the observable proof handles kept N bytes off the sandbox heap — then
    # drop every value it parked. One bucket sweep, no per-handle bookkeeping;
    # idempotent. A handle can't escape its execute: the result is encoded
    # inside the rescued execute proc (ensure_encodable) before reaching here,
    # and a Handle struct is not JSON-encodable, so a raw-handle return already
    # fails as an unencodable return rather than leaking a stale ref.
    case HandleStore.stats(HandleStore, id) do
      %{count: n, bytes: bytes} when n > 0 ->
        Logger.info("execute #{id} offloaded #{n} value(s), #{bytes} bytes kept off sandbox heap")

      _ ->
        :ok
    end

    HandleStore.release(HandleStore, id)

    {:noreply, st}
  end

  # A monitored process exited — either an execute proc or a tool_call caller.
  def handle_info({:DOWN, ref, :process, _pid, reason}, %State{} = st) do
    cond do
      # An execute proc exited. Clean exit → handled via :execute_done; a
      # non-normal exit without a result is a true crash → surface it.
      Map.has_key?(st.tasks, ref) ->
        {id, tasks} = Map.pop(st.tasks, ref)
        st = %{st | tasks: tasks}

        if reason == :normal do
          {:noreply, st}
        else
          Logger.error("execute proc crashed: #{inspect(reason)}")
          write(st, error_frame(id, @code_internal_error, "execute crashed: #{inspect(reason)}"))
          {:noreply, st}
        end

      # A tool_call caller (sandbox/pmap worker) died before Node responded
      # (timeout, sandbox kill, crash). Drop its dangling pending entry so it
      # cannot leak on this long-lived process (Review Gate 0, P2).
      Map.has_key?(st.callers, ref) ->
        {id, callers} = Map.pop(st.callers, ref)
        {_entry, pending} = Map.pop(st.pending, id)
        {:noreply, %{st | callers: callers, pending: pending}}

      true ->
        {:noreply, st}
    end
  end

  def handle_info(_other, st), do: {:noreply, st}

  # -------------------------------------------------------------------------
  # Dispatch
  # -------------------------------------------------------------------------

  # Response frame (reply to one of OUR tool_call requests).
  defp dispatch(%{"id" => id} = msg, %State{} = st)
       when is_map_key(msg, "result") or is_map_key(msg, "error") do
    case Map.pop(st.pending, id) do
      {nil, _} ->
        Logger.warning("response for unknown id #{inspect(id)}")
        st

      {{from, mref, exec_id}, pending} ->
        Process.demonitor(mref, [:flush])

        reply =
          case msg do
            # SPELL PATCH-3 (D-2): park a large result HERE, before the reply
            # copies it onto the sandbox worker's heap (the E1 OOM point). The
            # worker receives a small handle; the term stays in the store.
            %{"result" => r} -> {:ok, maybe_park(r, exec_id)}
            %{"error" => e} -> {:error, e}
          end

        GenServer.reply(from, reply)
        %{st | pending: pending, callers: Map.delete(st.callers, mref)}
    end
  end

  # Request frame from Node.
  defp dispatch(%{"method" => method, "id" => id} = msg, %State{} = st) do
    handle_request(method, id, Map.get(msg, "params", %{}), st)
  end

  defp dispatch(other, %State{} = st) do
    Logger.warning("invalid frame: #{inspect(other)}")
    write(st, error_frame(Map.get(other, "id"), @code_invalid_request, "invalid request"))
    st
  end

  defp handle_request("init", id, params, %State{} = st) do
    catalog = Map.get(params, "catalog", %{})
    tools = Bridge.build_tools(catalog, self())

    # PATCH-5: configure the session-store ceiling from the Node-side setting.
    # `sessionStoreBytes` is the operator's ceiling in bytes (converted from MB
    # at the Node boundary); a nil/absent value leaves the runtime default (64 MB).
    case Map.get(params, "sessionStoreBytes") do
      ceiling when is_integer(ceiling) and ceiling > 0 ->
        HandleStore.configure(HandleStore, ceiling)

      _ ->
        :ok
    end

    write(
      st,
      result_frame(id, %{
        "ok" => true,
        "protocol" => "2.0",
        "tools" => Bridge.tool_names(tools)
      })
    )

    %{st | initialized: true, catalog: catalog, tools: tools}
  end

  defp handle_request("execute", id, _params, %State{initialized: false} = st) do
    write(st, error_frame(id, @code_not_initialized, "runtime not initialized; send init first"))
    st
  end

  defp handle_request("execute", id, params, %State{} = st) do
    # Admission control (PLAN-323): cap executes running concurrently on this one
    # runtime. Each in-flight execute can hold up to `max_parallel_workers`
    # pmap workers; without a ceiling, N concurrent executes = N×worst-case heap,
    # an OOM vector on a long-lived session. Over the ceiling → a clean,
    # retryable error (the program never spawns), not a silent resource blowup.
    if map_size(st.tasks) >= st.max_concurrent_executes do
      write(
        st,
        error_frame(
          id,
          @code_capacity_exceeded,
          "too many concurrent executes (ceiling #{st.max_concurrent_executes}); retry when one completes",
          %{"reason" => "concurrent_capacity_exceeded"}
        )
      )

      st
    else
      program = Map.get(params, "program", "")
      peer = self()
      # Rebind the tools map for THIS execute so every reentrant tool_call carries
      # this execute's id (PLAN-324). The init-time `st.tools` (exec_id nil) is
      # only used for the names probe; real calls run under an id-bound map.
      exec_tools = Bridge.build_tools(st.catalog || %{}, peer, id)
      # SPELL PATCH-4 (D-6): seed this execute with the session's bound memory
      # (a snapshot at spawn). `(def x v)` in the program adds to it; the new
      # memory is captured on completion. The GenServer serializes the capture,
      # so concurrent executes can't corrupt the merge — last-completed wins
      # (acceptable for a sequential REPL-style binding cache).
      run_opts = execute_opts(params, exec_tools, st, id) |> Keyword.put(:memory, st.memory)

      {_pid, ref} =
        spawn_monitor(fn ->
          {wire_result, memory} = run_program(program, run_opts)
          send(peer, {:execute_done, id, wire_result, memory})
        end)

      %{st | tasks: Map.put(st.tasks, ref, id)}
    end
  end

  # Parse-only validation (W4 / FEAT-810): check a program parses and references
  # no unknown builtins/vars, running ZERO tool calls and ZERO effects. Used at
  # STORE time for a stored program so a typo can never be persisted as a live
  # tile and then fail effectfully on a later re-run. Available pre-init (it
  # touches no catalog state). Returns `{ok: true}` or `{ok: false, errors: [..]}`
  # where errors carry the same "Did you mean" hints as the in-band gate.
  defp handle_request("validate", id, params, %State{} = st) do
    program = Map.get(params, "program", "")

    result =
      case PtcRunner.Lisp.validate(program) do
        :ok -> %{"ok" => true}
        {:error, errors} -> %{"ok" => false, "errors" => errors}
      end

    write(st, result_frame(id, result))
    st
  end

  defp handle_request(method, id, _params, %State{} = st) do
    write(st, error_frame(id, @code_method_not_found, "unknown method: #{method}"))
    st
  end

  # -------------------------------------------------------------------------
  # Program execution (PtcRunner.Lisp.run wrapper)
  # -------------------------------------------------------------------------

  # Returns `{wire_result, memory}`: the wire_result is the JSON-RPC payload
  # (encodable value or error map); `memory` is the program's post-run
  # `step.memory` to persist as session bindings (SPELL PATCH-4), or `nil` to
  # leave bindings unchanged (a failed/crashed program does not mutate them).
  @spec run_program(String.t(), keyword()) ::
          {{:ok, term()} | {:error, %{message: String.t(), data: map()}}, map() | nil}
  defp run_program(program, opts) do
    case PtcRunner.Lisp.run(program, opts) do
      {:ok, step} ->
        # A SUCCESSFUL run commits its bindings regardless of whether the
        # RETURN encodes — `(def x v)` returns a non-encodable Var (`#'x`) yet
        # is the canonical way to bind, so binding capture must not hinge on
        # return encodability. The wire still gets the unencodable error when
        # the return itself can't serialize.
        #
        # EXCEPTION: a program that ended via `(fail ...)` returns the
        # `{:__ptc_fail__, _}` signal in the :ok tuple (a logical failure, not
        # a crash). Its `def`s must NOT commit — a failed program leaves
        # bindings untouched, same as the `{:error, step}` path.
        case step.return do
          {:__ptc_fail__, _} -> {ensure_encodable(step.return), nil}
          _ -> {ensure_encodable(step.return), step.memory}
        end

      {:error, step} ->
        fail = step.fail || %{}

        {{:error,
          %{
            message: Map.get(fail, :message) || "execution failed",
            data: %{
              "reason" => to_string(Map.get(fail, :reason) || "unknown"),
              "usage" => safe_usage(step)
            }
          }}, nil}
    end
  rescue
    e ->
      {{:error, %{message: Exception.message(e), data: %{"reason" => "exception"}}}, nil}
  end

  # A program may return a value Jason cannot encode (e.g. a closure from
  # `(fn [x] x)`). Encoding happens later in the Peer process; if it raised
  # there it would crash the ONLY long-lived process and drop all session state
  # (Review Gate 0, P1). Validate here, inside the rescued execute proc, and
  # downgrade a non-encodable return to a clean execute error.
  defp ensure_encodable(value) do
    case Jason.encode_to_iodata(value) do
      {:ok, _} ->
        {:ok, value}

      {:error, _} ->
        {:error,
         %{
           message: "program returned a non-serializable value",
           data: %{"reason" => "unencodable_return"}
         }}
    end
  end

  defp safe_usage(step) do
    case Map.get(step, :usage) do
      %{} = u -> u |> Map.take([:duration_ms, :memory_bytes]) |> stringify_keys()
      _ -> %{}
    end
  end

  defp stringify_keys(map), do: Map.new(map, fn {k, v} -> {to_string(k), v} end)

  # Translate execute params into PtcRunner.Lisp.run/2 options. Caps are clamped
  # to defensible ceilings; the program cannot ask for unbounded wall time.
  defp execute_opts(params, tools, %State{} = st, exec_id) do
    timeout = params |> Map.get("timeout_ms", 1_000) |> clamp(1, 30_000)

    [tools: tools, timeout: timeout, caller: :in_process_v1]
    |> maybe_put(:context, Map.get(params, "context"))
    |> maybe_put(:signature, Map.get(params, "signature"))
    # (max_parallel_workers 8, max_heap = 6_250_000 words ~50MB).
    |> maybe_put(:max_heap, request_max_heap(params, st))
    |> maybe_put(:worker_max_heap, st.worker_max_heap)
    |> maybe_put(:max_parallel_workers, st.max_parallel_workers)
    # SPELL PATCH-3 (D-2): hand the sandbox the store + this execute's GC bucket
    # so handle-aware builtins can project parked tool results in-place.
    |> Keyword.put(:handle_store, HandleStore)
    |> Keyword.put(:exec_id, exec_id)
  end

  # Re-home any %Handle{} bound in `memory` (SPELL PATCH-4) into the persistent
  # session bucket before its per-execute bucket is released, so the binding
  # survives as a SMALL handle (not a realized multi-MB term that would OOM the
  # next execute's bounded compile phase). A stale handle (already gone)
  # degrades to nil rather than crashing the session. Shallow over the binding
  # map's top-level values — the common `(def x (tool/...))` shape.
  #
  # The session bucket is never released by an execute; it is swept whole at
  # peer teardown (the BEAM exit drops the store). A rebind of the same name
  # leaves the prior term in the bucket until teardown — a bounded, session-
  # scoped cost acceptable for an interactive binding cache.
  defp persist_bindings(memory) do
    Map.new(memory, fn
      {k, %PtcRunner.Lisp.Handle{} = h} ->
        case HandleStore.rehome(HandleStore, h, @session_bucket) do
          {:ok, rehomed} ->
            {k, rehomed}

          {:error, :stale_handle} ->
            {k, nil}

          # The handle was already EVICTED by the reaper (session store hit its
          # ceiling). Keep the original handle as a stable tombstone so a later
          # read of this binding hits the loud evicted error again, rather than
          # crashing the Peer (CaseClauseError) or collapsing to a silent nil.
          {:error, {:evicted, _id}} ->
            {k, h}
        end

      {k, v} ->
        # A LARGE in-program-computed binding (e.g. `(def x <multi-MB list>)`,
        # never a tool result, so it was never parked) would be seeded verbatim
        # into the NEXT execute's bounded compile heap (~10MB, smaller than the
        # 50MB execute heap) and OOM it — poisoning EVERY later execute until
        # respawn. Park such a value into the session bucket so the binding is a
        # small handle on the compile heap, projected lazily. Small values pass
        # through unchanged.
        if (is_map(v) or is_list(v) or is_binary(v)) and
             :erlang.external_size(v) >= @handle_park_bytes do
          {k, HandleStore.put(HandleStore, v, @session_bucket)}
        else
          {k, v}
        end
    end)
  end

  # Park a large tool result in the HandleStore (returning a small handle) or
  # pass a small result through verbatim. Threshold in flat words (~256KB).
  # A handle escaping into a non-encodable wire position can't happen: results
  # are only parked on the path to a sandbox worker, never the execute reply.
  defp maybe_park(result, exec_id)
       when (is_map(result) or is_list(result) or is_binary(result)) and exec_id != nil do
    if :erlang.external_size(result) >= @handle_park_bytes do
      HandleStore.put(HandleStore, result, exec_id)
    else
      result
    end
  end

  defp maybe_park(result, _exec_id), do: result

  # Per-execute heap ceiling (FEAT-791): a positive-integer `max_heap` param
  # (in WORDS — Node converts from MB at its boundary) overrides the session
  # default for this one program, clamped to @max_heap_ceiling. Node already
  # enforces its operator-setting ceiling; this clamp is defense in depth
  # against a malformed/hostile frame. Non-integer or missing → session state.
  defp request_max_heap(params, %State{} = st) do
    case Map.get(params, "max_heap") do
      n when is_integer(n) and n > 0 -> min(n, @max_heap_ceiling)
      _ -> st.max_heap
    end
  end

  defp maybe_put(opts, _k, nil), do: opts
  defp maybe_put(opts, k, v), do: Keyword.put(opts, k, v)

  defp clamp(n, lo, hi) when is_integer(n), do: n |> max(lo) |> min(hi)
  defp clamp(_, lo, _), do: lo

  # -------------------------------------------------------------------------
  # Framing helpers
  # -------------------------------------------------------------------------

  defp decode(line) do
    case Jason.decode(line) do
      {:ok, %{} = m} -> {:ok, m}
      {:ok, _} -> {:error, "frame is not an object"}
      {:error, %Jason.DecodeError{} = e} -> {:error, Exception.message(e)}
    end
  end

  defp result_frame(id, value), do: %{"jsonrpc" => "2.0", "id" => id, "result" => value}

  defp error_frame(id, code, message, data \\ nil) do
    err = %{"code" => code, "message" => message}
    err = if data, do: Map.put(err, "data", data), else: err
    %{"jsonrpc" => "2.0", "id" => id, "error" => err}
  end

  # Non-raising frame write. Returns `{:error, reason}` if the frame cannot be
  # JSON-encoded so callers can degrade gracefully instead of crashing the Peer.
  defp write(%State{writer: writer}, frame) do
    case Jason.encode_to_iodata(frame) do
      {:ok, iodata} ->
        writer.([iodata, ?\n])
        :ok

      {:error, reason} ->
        Logger.error("frame encode failed: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp default_writer(iodata), do: IO.binwrite(:stdio, iodata)

  # -------------------------------------------------------------------------
  # Reader (production stdio pump)
  # -------------------------------------------------------------------------

  defp start_reader(peer) do
    spawn_link(fn -> reader_loop(peer) end)
  end

  defp reader_loop(peer) do
    # `binread` (not `IO.read`) so the reader pulls raw bytes, symmetric to the
    # `IO.binwrite` writer and consistent with the `:latin1` device set in
    # `init/1` (BUG-464). Jason decodes the UTF-8 bytes at the JSON layer.
    case IO.binread(:stdio, :line) do
      :eof ->
        send(peer, :eof)

      {:error, reason} ->
        Logger.error("stdin read error: #{inspect(reason)}")
        send(peer, :eof)

      data when is_binary(data) ->
        line = String.trim_trailing(data, "\n")
        if line != "", do: send(peer, {:frame, line})
        reader_loop(peer)
    end
  end
end
