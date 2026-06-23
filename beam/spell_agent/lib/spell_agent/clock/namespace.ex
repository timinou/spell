defmodule SpellAgent.Clock.Namespace do
  @moduledoc """
  The `clock/*` PTC-Lisp verb surface — the mind's handle on the A2 scheduler
  (PLAN-014).

  `tools/2` returns a `%{"clock/at" => fn args -> ... end, ...}` map whose closures
  capture the calling `session_id` (so a wake defaults to running in the SAME
  conversation that scheduled it) and the Clock server name. The map is merged
  into the agent's tools in `SpellAgent.Session.run/2`, exactly as `Hist.verbs/2`
  and `Mesh.verbs/2` are.

  ## The verbs

    * `clock/at`      — schedule a one-shot wake.
        `(tool/clock/at {:in "10m" :prompt "re-check my open goals"})`
    * `clock/every`   — schedule a repeating wake.
        `(tool/clock/every {:every "1h" :prompt "sweep for stuck goals"})`
    * `clock/cancel`  — cancel a wake by id. `(tool/clock/cancel {:id "wake-…"})`
    * `clock/pending` — list scheduled wakes + budget telemetry. `(tool/clock/pending {})`

  A wake's `:prompt` is the mission the woken run executes; `:session_id` defaults
  to the calling session (override to wake a different conversation); `:budget`
  (`{:turns N :cost_ceiling F}`) is threaded into `SpellAgent.run/2` and clamped to
  the body ceiling. `:in` / `:at` / `:every` accept a ms integer or a duration
  string (`"10m"`, `"90s"`, `"2h"`, `"500ms"`, `"1d"`).

  ## Posture

  Best-effort, mirroring `Mesh.Namespace`: a raise/exit inside a verb (a sick
  scheduler, a bad arg) is returned as `%{"err" => msg}`, never crashing the agent
  turn. When the Clock process is not running (e.g. a headless unit test without
  the supervisor), the verbs return a clear `%{"err" => …}` rather than blowing up.
  """

  alias SpellAgent.Clock

  @doc """
  The `clock/*` tool map for a `session_id`, targeting Clock server `server`
  (default `SpellAgent.Clock`). A wake scheduled without an explicit
  `:session_id` runs in `session_id`.
  """
  @spec tools(String.t(), GenServer.server()) :: %{optional(String.t()) => (map() -> term())}
  def tools(session_id, server \\ Clock) do
    %{
      "clock/at" => fn args -> guard(server, fn -> Clock.at(default_session(args, session_id), server) end) end,
      "clock/every" => fn args -> guard(server, fn -> Clock.every(default_session(args, session_id), server) end) end,
      "clock/cancel" => fn args -> guard(server, fn -> cancel(args, server) end) end,
      "clock/pending" => fn _args -> guard(server, fn -> Clock.pending(server) end) end
    }
  end

  defp cancel(args, server) do
    case flex(args, "id") do
      id when is_binary(id) -> Clock.cancel(id, server)
      _ -> %{"err" => "clock/cancel requires :id (a wake id from clock/at)"}
    end
  end

  # Default a wake's :session_id to the calling session so a self-scheduled wake
  # continues THIS conversation unless the agent explicitly targets another.
  defp default_session(args, session_id) when is_map(args) do
    if is_nil(flex(args, "session_id")), do: Map.put(args, "session_id", session_id), else: args
  end

  defp default_session(_args, session_id), do: %{"session_id" => session_id}

  # Run a verb body. If the Clock server is not alive, surface a clear error
  # instead of an exit; any other raise/exit becomes a best-effort {"err" …}.
  defp guard(server, fun) do
    if alive?(server) do
      fun.()
    else
      %{"err" => "clock scheduler not running"}
    end
  rescue
    e -> %{"err" => Exception.message(e)}
  catch
    :exit, reason -> %{"err" => "clock verb exit: #{inspect(reason)}"}
  end

  defp alive?(pid) when is_pid(pid), do: Process.alive?(pid)
  defp alive?(name) when is_atom(name), do: is_pid(Process.whereis(name))
  defp alive?(_), do: false

  defp flex(map, key) when is_map(map) and is_binary(key) do
    case Map.fetch(map, key) do
      {:ok, v} -> v
      :error -> Map.get(map, safe_atom(key))
    end
  end

  defp flex(_map, _key), do: nil

  defp safe_atom(k) when is_binary(k) do
    String.to_existing_atom(k)
  rescue
    ArgumentError -> nil
  end
end
