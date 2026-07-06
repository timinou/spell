defmodule SpellAgent.Tui.HumanTest do
  @moduledoc """
  FEAT-046 parts 4-5 (PLAN-027 M6): the `human/*` verb surface — the human's
  mind-surface for steering concurrent sessions. Defends: `human/list`
  reflects lineage as data, `human/spawn` routes through the ONE spawn
  gateway (`SpellAgent.Spawn.create/2`) with `owner: :human`, `human/adopt`
  re-parents an existing session, `human/watch` is a thin ok stub, and a bad
  arg on any verb returns `%{"err" => _}` rather than raising.
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp
  alias SpellAgent.SessionRegistry
  alias SpellAgent.Tui.Human

  setup do
    case Process.whereis(SessionRegistry) do
      nil -> start_supervised!({SessionRegistry, []})
      _ -> :ok
    end

    :ok
  end

  defp run(src), do: Lisp.run(src, tools: Human.tools(), caller: :in_process_v1)

  describe "human/list" do
    test "reflects live lineage as data" do
      SessionRegistry.register("sess-a", %{owner: :human, intent: "explore", region: "r1"})

      {:ok, step} = run(~s|(human/list {})|)
      ids = Enum.map(step.return, &Map.get(&1, "id"))
      assert "sess-a" in ids

      entry = Enum.find(step.return, &(Map.get(&1, "id") == "sess-a"))
      assert entry["owner"] == "human"
      assert entry["intent"] == "explore"
      assert entry["region"] == "r1"
      assert entry["status"] == "running"
    end
  end

  describe "human/spawn" do
    test "routes through Spawn.create with owner :human and lineage reflects it" do
      # Called directly (not through the Lisp sandbox process) so the
      # registered pid IS this test process, matching the registry's
      # self()-monitor contract.
      result = Human.tools()["human/spawn"].(%{"intent" => "steer this"})
      assert %{"ok" => true, "session-id" => sid} = result
      assert is_binary(sid)

      lineage = SessionRegistry.lineage()
      entry = Enum.find(lineage, &(&1.session_id == sid))
      assert entry
      assert entry.owner == :human
      assert entry.intent == "steer this"
    end

    test "bad arg (missing intent) returns err, never raises" do
      {:ok, step} = run(~s|(human/spawn {})|)
      assert %{"err" => _} = step.return
    end

    test "bad arg (missing intent) called directly returns err" do
      assert %{"err" => _} = Human.tools()["human/spawn"].(%{})
    end
  end

  describe "human/adopt" do
    test "re-parents a known session to :human" do
      SessionRegistry.register("sess-b", %{owner: {:session, "parent-1"}, intent: "child work"})

      # Called directly so `SessionRegistry.live?/1` (self()-scoped liveness
      # inside the registry's own bookkeeping) sees the same test process
      # that registered sess-b, not a transient Lisp-sandbox process.
      result = Human.tools()["human/adopt"].(%{"id" => "sess-b"})
      assert result == %{"ok" => true, "id" => "sess-b"}

      lineage = SessionRegistry.lineage()
      entry = Enum.find(lineage, &(&1.session_id == "sess-b"))
      assert entry.owner == :human
      # prior lineage fields preserved on re-register.
      assert entry.intent == "child work"
    end

    test "unknown id returns err" do
      {:ok, step} = run(~s|(human/adopt {:id "does-not-exist"})|)
      assert %{"err" => _} = step.return
    end

    test "missing id returns err, never raises" do
      {:ok, step} = run(~s|(human/adopt {})|)
      assert %{"err" => _} = step.return
    end
  end

  describe "human/watch" do
    test "thin ok stub echoes the watched id" do
      {:ok, step} = run(~s|(human/watch {:id "sess-a"})|)
      assert step.return == %{"ok" => true, "watching" => "sess-a"}
    end

    test "missing id returns err, never raises" do
      {:ok, step} = run(~s|(human/watch {})|)
      assert %{"err" => _} = step.return
    end
  end
end
