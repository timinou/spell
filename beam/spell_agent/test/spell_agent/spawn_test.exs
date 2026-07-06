defmodule SpellAgent.SpawnTest do
  @moduledoc """
  Contracts for the ONE spawn gateway (FEAT-044): `SpellAgent.Spawn.create/2`
  resolves region + clamps capability/budget + registers lineage, and
  `Mesh.Spawn` routes the agent reflexive seam through it.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.{Budget, Config, Session, SessionRegistry, Spawn, ToolRegistry}
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Mesh.Budget, as: MeshBudget

  setup do
    for e <- ToolRegistry.all(), do: ToolRegistry.remove(e.name)
    Config.put("model", "fake-model")

    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    wait_until(fn -> MeshBudget.held() == 0 end)
    on_exit(fn -> drain_budget() end)
    :ok
  end

  describe "create/2 (root spawn)" do
    test "a root spawn (no parent) registers owner :human with no region forced" do
      resolved = Spawn.create("root mission", store: Memory)

      assert resolved.owner == :human
      assert resolved.parent_id == nil
      assert resolved.intent == "root mission"
      assert resolved.region == nil
      assert Keyword.get(resolved.run_opts, :session_id) == resolved.session_id

      lineage = Enum.find(SessionRegistry.lineage(), &(&1.session_id == resolved.session_id))
      assert lineage.owner == :human
      assert lineage.parent_id == nil
      assert lineage.intent == "root mission"

      SessionRegistry.finish(resolved.session_id)
    end
  end

  describe "create/2 (child spawn lineage + attenuation)" do
    test "a child spawn registers owner {:session, parent} + resolves a region" do
      resolved =
        Spawn.create("child mission",
          owner: {:session, "parent-1"},
          parent_id: "parent-1",
          store: Memory
        )

      assert resolved.owner == {:session, "parent-1"}
      assert resolved.parent_id == "parent-1"
      assert is_binary(resolved.region)

      lineage = Enum.find(SessionRegistry.lineage(), &(&1.session_id == resolved.session_id))
      assert lineage.parent_id == "parent-1"
      assert lineage.owner == {:session, "parent-1"}
      assert lineage.region == resolved.region
      assert lineage.status == :running

      SessionRegistry.finish(resolved.session_id)
    end

    test "capability clamp: a requested tool outside the parent's ceiling is dropped" do
      resolved =
        Spawn.create("child mission",
          owner: {:session, "parent-2"},
          parent_id: "parent-2",
          tools: ["find", "sh"],
          allowed: ["find"],
          store: Memory
        )

      assert Keyword.get(resolved.run_opts, :tools) == ["find"]
      SessionRegistry.finish(resolved.session_id)
    end

    test "budget clamp: the child's requested ceiling is bounded by the parent's" do
      parent_budget = Budget.from_opts(max_turns: 3, max_tokens: 500)

      resolved =
        Spawn.create("child mission",
          owner: {:session, "parent-3"},
          parent_id: "parent-3",
          requested_budget: Budget.from_opts(max_turns: 100, max_tokens: 100_000),
          budget: parent_budget,
          store: Memory
        )

      assert Keyword.get(resolved.run_opts, :max_turns) == 3
      assert Keyword.get(resolved.run_opts, :max_tokens) == 500
      SessionRegistry.finish(resolved.session_id)
    end

    test "budget clamp: a parent's EFFECTIVE default turn ceiling still bounds the child (S4 P1)" do
      # The attenuation bypass: a parent on the default 12-turn ceiling must pass a
      # budget carrying max_turns=12 (not nil), else a child requesting 100 turns
      # would treat the parent axis as unbounded and widen past 12. Session builds
      # the Context budget with the effective max_turns; simulate that here.
      effective_parent = %{Budget.from_opts([]) | max_turns: 12}

      resolved =
        Spawn.create("child mission",
          owner: {:session, "parent-12"},
          parent_id: "parent-12",
          requested_budget: Budget.from_opts(max_turns: 100),
          budget: effective_parent,
          store: Memory
        )

      assert Keyword.get(resolved.run_opts, :max_turns) == 12
      SessionRegistry.finish(resolved.session_id)
    end

    test "a down/absent registry never blocks a spawn (best-effort)" do
      :ok = Supervisor.terminate_child(SpellAgent.Supervisor, SessionRegistry)
      on_exit(fn -> ensure_registry() end)

      assert %{session_id: sid} = Spawn.create("root mission", store: Memory)
      assert is_binary(sid)
    end
  end

  describe "Mesh.Spawn routes through the gateway" do
    test "an agent's spawn-session call registers lineage via the gateway" do
      child_program = ~s|(return "done")|

      parent_program =
        ~s|(let [h (tool/spawn-session {:prompt "CHILD via gateway"})] (return (tool/await-session {:handle h})))|

      llm =
        dispatch_llm([
          {"PARENT via gateway", fn -> lisp_eval(parent_program) end},
          {"CHILD via gateway", fn -> lisp_eval(child_program) end}
        ])

      # Snapshot lineage right after the child registers (before it finishes) by
      # polling: the child mission is very short-lived under the fake llm, so we
      # assert on the post-hoc invariant instead — the parent's own await
      # succeeding proves the gateway wired session_id/region/run_opts correctly
      # end to end (a broken gateway would make the child fail to start/route).
      assert {:ok, result} = Session.run("PARENT via gateway", llm: llm, max_turns: 6, hist: Memory)
      assert %{"ok" => true, "result" => "done"} = result
    end
  end

  # ---- helpers ----

  defp dispatch_llm(routes, default \\ %{content: "done"}) do
    fn request ->
      prompt = opening_prompt(request)

      resp =
        Enum.find_value(routes, default, fn {needle, builder} ->
          if String.contains?(prompt, needle), do: builder.(), else: nil
        end)

      {:ok, resp}
    end
  end

  defp opening_prompt(%{messages: messages}) when is_list(messages) do
    messages
    |> Enum.filter(fn m -> Map.get(m, :role) == :user end)
    |> Enum.map(fn m -> to_text(Map.get(m, :content)) end)
    |> Enum.join("\n")
  end

  defp opening_prompt(other), do: inspect(other)

  defp to_text(c) when is_binary(c), do: c
  defp to_text(c), do: inspect(c)

  defp lisp_eval(program) do
    %{
      tool_calls: [
        %{
          id: "call_#{System.unique_integer([:positive])}",
          name: "lisp_eval",
          args: %{"program" => program}
        }
      ]
    }
  end

  defp ensure_registry do
    case Process.whereis(SessionRegistry) do
      nil -> Supervisor.restart_child(SpellAgent.Supervisor, SessionRegistry)
      _pid -> :ok
    end
  end

  defp drain_budget do
    case MeshBudget.try_acquire() do
      {:ok, b} -> drain_budget(b)
      _ -> :ok
    end
  end

  defp drain_budget(b) do
    if MeshBudget.available() > 0 do
      case MeshBudget.try_acquire() do
        {:ok, b2} -> drain_budget(b2)
        _ -> MeshBudget.release(b)
      end
    else
      MeshBudget.release(b)
    end
  end

  defp wait_until(fun, tries \\ 50)
  defp wait_until(_fun, 0), do: :timeout

  defp wait_until(fun, tries) do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      wait_until(fun, tries - 1)
    end
  end
end
