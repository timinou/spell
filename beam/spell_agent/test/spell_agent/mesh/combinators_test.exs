defmodule SpellAgent.Mesh.CombinatorsTest do
  @moduledoc """
  Contracts for the mesh ergonomic combinators (FEAT-018 S-A/S-B, PLAN-019 M5),
  shipped as .ptc source over the FEAT-011 spawn primitives. Driven by a
  prompt-dispatching fake llm (zero network), the same harness as the spawn tests.

  Pins: mesh/ask returns a single child's result; mesh/mesh-map fans out one child
  per item and collects results in order; the combinators are pure Lisp sugar that
  resolves tool/spawn-session from the assembled session tools; :inherit-memory
  seeds a child's def-env.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.{Config, Session, ToolRegistry}
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Mesh.Budget

  setup do
    for e <- ToolRegistry.all(), do: ToolRegistry.remove(e.name)
    Config.put("model", "fake-model")

    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    wait_until(fn -> Budget.held() == 0 end)
    on_exit(&drain_budget/0)
    :ok
  end

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
        %{id: "call_#{System.unique_integer([:positive])}", name: "lisp_eval", args: %{"program" => program}}
      ]
    }
  end

  describe "mesh/ask" do
    test "spawns a child toward :prompt and returns its result" do
      child = ~s|(return "child-answer")|
      parent = ~s|(return (tool/mesh/ask {:prompt "CHILD do it"}))|

      llm =
        dispatch_llm([
          {"PARENT ask", fn -> lisp_eval(parent) end},
          {"CHILD do it", fn -> lisp_eval(child) end}
        ])

      assert {:ok, result} = Session.run("PARENT ask", llm: llm, max_turns: 6, hist: Memory)
      # ask returns await-session's map; the child's value is unwrapped under "result".
      assert %{"ok" => true, "result" => "child-answer"} = result
    end
  end

  describe "mesh/mesh-map" do
    test "fans out one child per item and collects results in order" do
      # Each child returns a marker; the parent mesh-maps over 3 items and gets 3
      # result maps back. All children share one region (fan-out + collect).
      child = ~s|(return "ok")|

      parent =
        ~s|(return (count (tool/mesh/mesh-map {:items ["a" "b" "c"] :prompt "WORKER item " :region "shared-region"})))|

      llm =
        dispatch_llm([
          {"PARENT map", fn -> lisp_eval(parent) end},
          {"WORKER item", fn -> lisp_eval(child) end}
        ])

      assert {:ok, count} = Session.run("PARENT map", llm: llm, max_turns: 8, hist: Memory)
      assert count == 3
    end
  end

  describe "mesh/scatter + mesh/gather" do
    test "scatter returns handles; gather awaits them" do
      child = ~s|(return "g")|

      # scatter -> handles, then gather -> results. Bind handles, count the gather.
      parent =
        ~s|(let [hs (tool/mesh/scatter {:items ["x" "y"] :prompt "GW item " :region "scatter-region"})] (return (count (tool/mesh/gather {:handles hs}))))|

      llm =
        dispatch_llm([
          {"PARENT scat", fn -> lisp_eval(parent) end},
          {"GW item", fn -> lisp_eval(child) end}
        ])

      assert {:ok, count} = Session.run("PARENT scat", llm: llm, max_turns: 8, hist: Memory)
      assert count == 2
    end
  end

  describe "BUG-020 capacity-safe fan-out" do
    test "gather passes a settled err marker through and awaits real handles" do
      # The parent scatters 2 children (both spawn fine), then prepends a synthetic
      # err marker to the handle list and gathers. The err marker passes through
      # unchanged; the real handles are awaited. Proves gather tolerates the
      # per-item error markers scatter emits when a spawn hits capacity (so a
      # partial fan-out never loses the children that did spawn).
      child = ~s|(return "ok")|

      parent =
        ~s|(let [hs (tool/mesh/scatter {:items ["a" "b"] :prompt "FW item " :region "cap-region"}) mixed (cons {"err" "capacity"} hs)] (return (tool/mesh/gather {:handles mixed})))|

      llm =
        dispatch_llm([
          {"PARENT cap", fn -> lisp_eval(parent) end},
          {"FW item", fn -> lisp_eval(child) end}
        ])

      assert {:ok, results} = Session.run("PARENT cap", llm: llm, max_turns: 8, hist: Memory)
      assert is_list(results)
      assert length(results) == 3
      # The first entry is the err marker, passed through unchanged.
      assert %{"err" => "capacity"} = hd(results)
      # The other two are awaited child results.
      assert Enum.count(results, fn r -> match?(%{"ok" => true}, r) end) == 2
    end
  end

  describe "S-E inherit_memory" do
    test "a child spawned with :inherit-memory can reference the seeded binding" do
      # The child reads a binding it never defined — proving the seed reached its
      # def-env. It returns the bound value.
      child = ~s|(return callers)|

      parent =
        ~s|(return (tool/mesh/ask {:prompt "CHILD mem" :inherit-memory {"callers" "seeded-value"}}))|

      llm =
        dispatch_llm([
          {"PARENT mem", fn -> lisp_eval(parent) end},
          {"CHILD mem", fn -> lisp_eval(child) end}
        ])

      assert {:ok, result} = Session.run("PARENT mem", llm: llm, max_turns: 6, hist: Memory)
      assert %{"ok" => true, "result" => "seeded-value"} = result
    end
  end

  # ---- helpers ----

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
