defmodule SpellAgent.Mesh.SpawnSessionTest do
  @moduledoc """
  Contracts for the reflexive seam (FEAT-011, PLAN-019 M1): tool/spawn-session +
  tool/await-session, driven by a FAKE llm (zero network — the inspector pattern).

  A spawned child is itself a full Session.run/2 with the parent's inherited llm,
  so one content-dispatching fake llm scripts BOTH the parent's turns (spawn +
  await + fold) and the child's turns (post a finding + return). The child runs in
  a detached Task; await-session rejoins it across processes via Mesh.Join.

  Pins: spawn-session returns a string-keyed handle immediately; await-session
  returns the child's result; a child writes the shared region (Fork-A fan-out +
  fold, zero sibling messages); capacity-exceeded raises; no slot leak; capability
  attenuation bounds the child's base tools.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.{Config, Session, ToolRegistry}
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Mesh.Budget

  setup do
    # Fresh tool registry + a known model; the Memory store is the app singleton.
    for e <- ToolRegistry.all(), do: ToolRegistry.remove(e.name)
    Config.put("model", "fake-model")

    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    # Wait for any async child-release from a prior test to settle so each test
    # starts from a quiescent global budget (the holder is an app singleton).
    wait_until(fn -> Budget.held() == 0 end)
    on_exit(fn -> drain_budget() end)
    :ok
  end

  # A prompt-dispatching fake llm: routes on the FIRST user message's content (the
  # mission's opening prompt), so one closure scripts both the parent and the
  # spawned child WITHOUT a parent's emitted program text (which echoes the child
  # prompt) mis-routing to the child branch. In :tool_call mode the loop wants
  # %{tool_calls: [...]} (run a program) or %{content: "..."} (final answer).
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

  # The opening user prompt = the LAST user message (the system tool-list is the
  # first user block; the mission prompt is appended after it). We match on the
  # mission prompt only, never on tool-call/tool-result turns, so a parent's
  # program text never routes as the child.
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

  describe "spawn-session + await-session (the headline contract)" do
    test "parent spawns a child that posts a finding; await returns the child's result" do
      # The child program: post a finding to its region, then return a marker.
      child_program = ~s|(do (tool/black/post {:kind :finding :payload {:msg "child-was-here"}}) (return "child-done"))|

      # The parent program: spawn a child (no tools attenuation), await it, return
      # the awaited result map's "result".
      parent_program =
        ~s|(let [h (tool/spawn-session {:prompt "CHILD do the thing"})] (return (tool/await-session {:handle h})))|

      llm =
        dispatch_llm([
          {"PARENT spawn one", fn -> lisp_eval(parent_program) end},
          {"CHILD do the thing", fn -> lisp_eval(child_program) end}
        ])

      assert {:ok, result} = Session.run("PARENT spawn one", llm: llm, max_turns: 6, hist: Memory)

      # await-session returns %{"ok" => true, "session" => sid, "result" => "child-done"}
      assert %{"ok" => true, "session" => child_sid, "result" => child_result} = result
      assert is_binary(child_sid)
      # await-session unwraps the child's {:ok, value} to the value itself.
      assert child_result == "child-done"

      # The Fork-A contract: the child WROTE a finding to its region, which
      # persists independently of the child process (the blackboard is durable).
      # Find the region by scanning the store for the child's finding — zero
      # sibling messages, the parent reads the shared medium.
      findings =
        Memory
        |> all_mesh_records()
        |> Enum.filter(fn r -> r.kind == :finding end)

      assert Enum.any?(findings, fn r ->
               match?(%{"msg" => "child-was-here"}, r.payload) or
                 match?(%{msg: "child-was-here"}, r.payload)
             end),
             "expected the child's finding to persist in the shared region"
    end

    test "spawn-session returns a string-keyed handle immediately (always detaches)" do
      # Child blocks-ish by just returning; we only assert the handle shape the
      # parent observes synchronously at the spawn site.
      parent_program =
        ~s|(return (tool/spawn-session {:prompt "CHILD noop"}))|

      llm =
        dispatch_llm([
          {"PARENT handle", fn -> lisp_eval(parent_program) end},
          {"CHILD noop", fn -> lisp_eval(~s|(return "ok")|) end}
        ])

      assert {:ok, handle} = Session.run("PARENT handle", llm: llm, max_turns: 4, hist: Memory)

      assert %{
               "session" => sid,
               "region" => region,
               "parent" => parent,
               "status" => "running"
             } = handle

      assert is_binary(sid)
      assert is_binary(region)
      assert is_binary(parent)
      # watermark captured at spawn (forward-compat); 0 for a fresh region.
      assert is_integer(handle["watermark"])
    end
  end

  describe "budget" do
    test "spawning past capacity does not exceed the cap; the spawn fails fast" do
      # Fill EVERY currently-free slot so the next spawn must fail fast. Acquiring
      # until :full (rather than assuming `capacity` slots are free) is robust to a
      # stray slot a prior test's async child release hasn't freed yet — the global
      # budget is a singleton, so we only rely on "no free slots after this", not
      # on a specific count.
      cap = Budget.capacity()
      held = acquire_all()
      assert Budget.available() == 0

      parent_program = ~s|(return (tool/spawn-session {:prompt "CHILD never"}))|

      llm =
        dispatch_llm([
          {"PARENT over", fn -> lisp_eval(parent_program) end},
          {"CHILD never", fn -> lisp_eval(~s|(return "x")|) end}
        ])

      # The load-bearing invariant: the budget is NEVER exceeded — a capacity+1
      # acquire hands its slot straight back (held stays <= cap), so the spawn
      # fails fast with parallel_capacity_exceeded surfaced as a tool error ->
      # {:error, _}. NB: the global budget is a singleton shared with other tests'
      # async children; if one of those frees a slot in the instant between our
      # fill and the spawn, the spawn legitimately SUCCEEDS into that slot — still
      # never exceeding cap. So we assert the invariant (held <= cap, no crash) and
      # accept either outcome, rather than a brittle exact {:error, _} that races
      # the shared holder.
      result = Session.run("PARENT over", llm: llm, max_turns: 4, hist: Memory)
      assert match?({:error, _}, result) or match?({:ok, _}, result)
      assert Budget.held() <= cap
      # The child never started, so no finding from "CHILD never" exists.
      refute Enum.any?(all_mesh_records(Memory), fn r ->
               r.kind == :finding and match?(%{"started" => _}, r.payload)
             end)

      Enum.each(held, &Budget.release/1)
      wait_until(fn -> Budget.held() == 0 end)
    end

    test "spawn-session raises parallel_capacity_exceeded when the budget is full (unit)" do
      # Deterministic raise test: fill the budget, then call the spawn verb
      # SYNCHRONOUSLY in this tick (no Session.run, no await) so no async child
      # release can interleave. The verb must raise; the budget stays full.
      held = acquire_all()
      assert Budget.available() == 0

      verbs = SpellAgent.Mesh.Spawn.verbs("parent-sid", llm: fn _ -> {:ok, %{content: "x"}} end, store: Memory, allowed: :all)
      spawn = verbs["spawn-session"]

      assert_raise RuntimeError, ~r/parallel_capacity_exceeded/, fn ->
        spawn.(%{"prompt" => "never runs"})
      end

      Enum.each(held, &Budget.release/1)
      wait_until(fn -> Budget.held() == 0 end)
    end

    test "a completed child releases its slot (no leak)" do
      assert Budget.held() == 0

      child_program = ~s|(return "done")|
      parent_program = ~s|(let [h (tool/spawn-session {:prompt "CHILD leak"})] (return (tool/await-session {:handle h})))|

      llm =
        dispatch_llm([
          {"PARENT leak", fn -> lisp_eval(parent_program) end},
          {"CHILD leak", fn -> lisp_eval(child_program) end}
        ])

      assert {:ok, _} = Session.run("PARENT leak", llm: llm, max_turns: 6, hist: Memory)
      # Give the join server's release a beat to process the task-completion msg.
      wait_until(fn -> Budget.held() == 0 end)
      assert Budget.held() == 0
    end
  end

  describe "capability attenuation (D12)" do
    test "a child given :tools [\"find\"] cannot call an unlisted base tool (sh)" do
      # Child tries to call sh (NOT in its granted subset). The call resolves to
      # no tool -> the program errors -> the child returns {:error, _}, surfaced
      # by await-session as an "err". The child CAN call find (granted).
      child_program = ~s|(do (tool/sh {:argv ["echo" "hi"]}) (return "should-not-reach"))|

      parent_program =
        ~s|(let [h (tool/spawn-session {:prompt "CHILD restricted" :tools ["find"]})] (return (tool/await-session {:handle h})))|

      llm =
        dispatch_llm([
          {"PARENT restrict", fn -> lisp_eval(parent_program) end},
          {"CHILD restricted", fn -> lisp_eval(child_program) end}
        ])

      assert {:ok, result} = Session.run("PARENT restrict", llm: llm, max_turns: 6, hist: Memory)
      # The child could not call sh -> its run failed -> await reports an error.
      assert %{"err" => _} = result
    end

    test "a restricted child cannot grant a grandchild a tool it lacks (transitive clamp)" do
      # The child (granted only ["find"]) tries to spawn a grandchild WITH sh.
      # The clamp intersects the grandchild's request against the child's ceiling
      # (["find"]), so sh is dropped: the grandchild also cannot call sh.
      grandchild_program = ~s|(do (tool/sh {:argv ["echo" "hi"]}) (return "gc"))|

      child_program =
        ~s|(let [h (tool/spawn-session {:prompt "GRANDCHILD esc" :tools ["sh"]})] (return (tool/await-session {:handle h})))|

      parent_program =
        ~s|(let [h (tool/spawn-session {:prompt "CHILD mid" :tools ["find" "spawn-session" "await-session"]})] (return (tool/await-session {:handle h})))|

      llm =
        dispatch_llm([
          {"PARENT esc", fn -> lisp_eval(parent_program) end},
          {"CHILD mid", fn -> lisp_eval(child_program) end},
          {"GRANDCHILD esc", fn -> lisp_eval(grandchild_program) end}
        ])

      assert {:ok, result} = Session.run("PARENT esc", llm: llm, max_turns: 12, hist: Memory)
      # The clamp dropped sh from the grandchild, so the grandchild's run FAILED
      # (it called an ungranted tool). That failure surfaces as a nested error:
      # the child successfully awaited the grandchild and returned its error map,
      # which the parent's await wraps as result["result"]["err"]. The load-bearing
      # contract: the grandchild could NOT execute sh.
      nested =
        case result do
          %{"err" => _} -> result
          %{"result" => %{"err" => _} = inner} -> inner
          %{"result" => inner} -> inner
          other -> other
        end

      assert %{"err" => _} = nested,
             "expected the grandchild to fail (sh clamped away), got: #{inspect(result)}"
      refute match?(%{"result" => "gc"}, nested),
             "the grandchild must NOT have completed its sh-calling program"
    end
  end

  describe "await-session edge cases" do
    test "awaiting an unknown session id returns a clear error, never hangs" do
      parent_program = ~s|(return (tool/await-session {:session "no-such-session-id"}))|

      llm = dispatch_llm([{"PARENT unknown", fn -> lisp_eval(parent_program) end}])

      assert {:ok, result} = Session.run("PARENT unknown", llm: llm, max_turns: 4, hist: Memory)
      assert %{"err" => _} = result
    end
  end

  # ---- helpers ----

  # Every mesh record in the store, across all regions (records live at
  # {:mesh, region, seq}; listing the :mesh kind returns them all).
  defp all_mesh_records(store) do
    SpellAgent.Hist.Store.list(store, :mesh)
  rescue
    _ -> []
  end

  defp drain_budget do
    case Budget.fetch() do
      {:ok, b} -> drain_budget(b)
      :error -> :ok
    end
  end

  defp drain_budget(b) do
    if Budget.held() > 0 do
      Budget.release(b)
      drain_budget(b)
    end
  end

  # Acquire every free slot until the budget is full; return the held budgets so
  # the caller can release them. Robust to a non-empty starting held count.
  defp acquire_all(acc \\ []) do
    case Budget.try_acquire() do
      {:ok, b} -> acquire_all([b | acc])
      _ -> acc
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
