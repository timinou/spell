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

  alias PtcRuntime.Bridge

  @type writer :: (iodata() -> :ok)

  # JSON-RPC error codes (-32xxx reserved by spec; -320xx = our domain).
  @code_parse_error -32_700
  @code_invalid_request -32_600
  @code_method_not_found -32_601
  @code_internal_error -32_603
  @code_not_initialized -32_001
  @code_execute_failed -32_002

  # How long a single tool_call may wait for Node before the worker gives up.
  # Generous: Node may itself be doing slow IO (bash, network).
  @tool_call_timeout 120_000

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
              tasks: %{}
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

    if autostart, do: start_reader(self())

    {:ok, %State{writer: writer}}
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
             pending: Map.put(st.pending, id, {from, mref}),
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
  def handle_info({:execute_done, id, result}, %State{} = st) do
    case result do
      {:ok, value} ->
        write(st, result_frame(id, value))

      {:error, frame} ->
        write(st, error_frame(id, @code_execute_failed, frame.message, frame.data))
    end

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

      {{from, mref}, pending} ->
        Process.demonitor(mref, [:flush])

        reply =
          case msg do
            %{"result" => r} -> {:ok, r}
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
    program = Map.get(params, "program", "")
    peer = self()
    # Rebind the tools map for THIS execute so every reentrant tool_call carries
    # this execute's id (PLAN-324). The init-time `st.tools` (exec_id nil) is
    # only used for the names probe; real calls run under an id-bound map.
    exec_tools = Bridge.build_tools(st.catalog || %{}, peer, id)
    run_opts = execute_opts(params, exec_tools)

    {_pid, ref} =
      spawn_monitor(fn ->
        send(peer, {:execute_done, id, run_program(program, run_opts)})
      end)

    %{st | tasks: Map.put(st.tasks, ref, id)}
  end

  defp handle_request(method, id, _params, %State{} = st) do
    write(st, error_frame(id, @code_method_not_found, "unknown method: #{method}"))
    st
  end

  # -------------------------------------------------------------------------
  # Program execution (PtcRunner.Lisp.run wrapper)
  # -------------------------------------------------------------------------

  @spec run_program(String.t(), keyword()) ::
          {:ok, term()} | {:error, %{message: String.t(), data: map()}}
  defp run_program(program, opts) do
    case PtcRunner.Lisp.run(program, opts) do
      {:ok, step} ->
        ensure_encodable(step.return)

      {:error, step} ->
        fail = step.fail || %{}

        {:error,
         %{
           message: Map.get(fail, :message) || "execution failed",
           data: %{
             "reason" => to_string(Map.get(fail, :reason) || "unknown"),
             "usage" => safe_usage(step)
           }
         }}
    end
  rescue
    e ->
      {:error, %{message: Exception.message(e), data: %{"reason" => "exception"}}}
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
  defp execute_opts(params, tools) do
    timeout = params |> Map.get("timeout_ms", 1_000) |> clamp(1, 30_000)

    [tools: tools, timeout: timeout, caller: :in_process_v1]
    |> maybe_put(:context, Map.get(params, "context"))
    |> maybe_put(:signature, Map.get(params, "signature"))
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
    case IO.read(:stdio, :line) do
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
