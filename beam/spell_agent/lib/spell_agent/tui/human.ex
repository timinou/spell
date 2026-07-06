defmodule SpellAgent.Tui.Human do
  @moduledoc """
  The `human/` tool surface (FEAT-046 parts 4-5, PLAN-027 M6) — the human's
  mind-surface for STEERING concurrent sessions in the multi-session cockpit,
  addressed by session id. The peer of `black/*` (the agent's own mesh
  surface), but scoped to the unrestricted human root rather than a spawning
  session.

  ## Verbs

    * `human/list {}` — the live spawn-lineage (`SessionRegistry.lineage/0`)
      as data: `[%{"id","owner","parent-id","intent","region","status"}, …]`.
      Best-effort — `[]` if the registry is down.

    * `human/spawn {:intent "…" :tools? […] :budget? {…}}` — spawn a new
      session owned by the human, routed through the ONE spawn gateway
      (`SpellAgent.Spawn.create/2`, `owner: :human`). Returns
      `%{"ok" => true, "session-id" => sid}`. This resolves + registers
      lineage; it does not itself run the child process (same posture as
      `Spawn.create/2` — the caller decides how to actually run it).

    * `human/adopt {:id "…"}` — re-parent an existing session to the human
      root by re-registering it with `owner: :human` (the registry's
      register/2 preserves prior lineage fields on re-register, per its S4 P2
      fix — only `:owner` is overridden here). Best-effort; an unknown/blank
      id is a clear authoring error, not a crash.

    * `human/watch {:id "…"}` — a thin, no-op-safe stub recording watch
      intent. The actual "drill into this session's stream" reaction lives on
      the cockpit's main thread; this verb only echoes the intent back as
      data so the mind can confirm the id it asked to watch.

  `human/interrupt` is explicitly OUT of scope here (FUP-035, oracle-gated).

  All verbs are TOTAL + best-effort: a bad arg never raises, it returns
  `%{"err" => reason}`.
  """

  alias SpellAgent.{SessionRegistry, Spawn}
  alias SpellAgent.Tui.Tree

  @doc "The `human/` verb tool map (qualified string names)."
  @spec tools() :: %{optional(String.t()) => (map() -> term())}
  def tools do
    %{
      "human/list" => fn _args -> list() end,
      "human/spawn" => &spawn_session/1,
      "human/adopt" => &adopt/1,
      "human/watch" => &watch/1
    }
  end

  # ---- human/list ----

  defp list do
    SessionRegistry.lineage()
    |> Enum.map(fn entry ->
      %{
        "id" => entry.session_id,
        "owner" => owner_label(entry.owner),
        "parent-id" => entry.parent_id,
        "intent" => entry.intent,
        "region" => entry.region,
        "status" => to_string(entry.status)
      }
    end)
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  defp owner_label(:human), do: "human"
  defp owner_label({:session, id}), do: id
  defp owner_label(other), do: to_string(other)

  # ---- human/spawn ----

  defp spawn_session(args) when is_map(args) do
    case strget(args, "intent") do
      intent when is_binary(intent) and intent != "" ->
        opts =
          [owner: :human]
          |> maybe_put(:tools, tools_arg(args))
          |> maybe_put(:cost_ceiling, budget_arg(args))

        resolved = Spawn.create(intent, opts)
        %{"ok" => true, "session-id" => resolved.session_id}

      _ ->
        %{"err" => "human/spawn requires an :intent string"}
    end
  rescue
    e -> %{"err" => "human/spawn failed: #{Exception.message(e)}"}
  catch
    :exit, reason -> %{"err" => "human/spawn failed: #{inspect(reason)}"}
  end

  defp spawn_session(_), do: %{"err" => "human/spawn requires an args map"}

  defp tools_arg(args) do
    case strget(args, "tools") do
      list when is_list(list) -> list
      _ -> nil
    end
  end

  defp budget_arg(args) do
    case strget(args, "budget") do
      n when is_number(n) -> n
      _ -> nil
    end
  end

  # ---- human/adopt ----

  defp adopt(args) when is_map(args) do
    case strget(args, "id") do
      id when is_binary(id) and id != "" ->
        if SessionRegistry.live?(id) do
          SessionRegistry.register(id, %{owner: :human})
          %{"ok" => true, "id" => id}
        else
          %{"err" => "human/adopt: unknown session #{id}"}
        end

      _ ->
        %{"err" => "human/adopt requires an :id string"}
    end
  rescue
    e -> %{"err" => "human/adopt failed: #{Exception.message(e)}"}
  catch
    :exit, reason -> %{"err" => "human/adopt failed: #{inspect(reason)}"}
  end

  defp adopt(_), do: %{"err" => "human/adopt requires an args map"}

  # ---- human/watch ----

  defp watch(args) when is_map(args) do
    case strget(args, "id") do
      id when is_binary(id) and id != "" -> %{"ok" => true, "watching" => id}
      _ -> %{"err" => "human/watch requires an :id string"}
    end
  end

  defp watch(_), do: %{"err" => "human/watch requires an args map"}

  # ---- helpers ----

  defp strget(args, key), do: Tree.get(args, key)

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, key, value), do: Keyword.put(opts, key, value)
end
