defmodule PtcRuntime.PreflightLintTest do
  @moduledoc """
  SPELL PATCH-2 (D-5): preflight lint hint enrichment.

  A hallucinated builtin is rejected by the undefined-var gate that runs in
  the compile phase BEFORE any tool executes (0 effects). These tests pin two
  properties:

    1. the failure is pre-effect (no tool is called), and
    2. the message carries an actionable hint (nearest builtin / known
       Clojure-name alternative / hyphen-vs-underscore), routed through the
       same `Helpers.format_closure_error/1` the runtime closure path uses.
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp

  # A tool that records whether it was ever invoked. The lint gate must reject
  # before this fires.
  defp tracking_tools do
    {:ok, agent} = Agent.start_link(fn -> false end)

    tools = %{
      "ping" => fn _ ->
        Agent.update(agent, fn _ -> true end)
        :ok
      end
    }

    {tools, agent}
  end

  describe "pre-execution gate fires before any effect" do
    test "a hallucinated builtin fails with zero tool calls" do
      {tools, agent} = tracking_tools()

      # The (tool/ping) sits BEFORE the bad symbol in eval order, yet must not
      # run: the compile-phase undefined-var check rejects the whole program.
      src = ~S|(do (tool/ping {}) (map-vals inc {"a" 1}))|
      assert {:error, step} = Lisp.run(src, tools: tools)
      assert step.fail.reason == :unbound_var
      refute Agent.get(agent, & &1), "no tool may run when preflight rejects"
    end
  end

  describe "hint enrichment" do
    defp fail_message(src) do
      {:error, step} = Lisp.run(src, tools: %{})
      step.fail.message
    end

    test "known Clojure-name confusion → named alternative" do
      assert fail_message(~S|(map-vals inc {"a" 1})|) =~ "update-vals"
      assert fail_message(~S|(map-keys f m)|) =~ "update-keys"
    end

    test "near-miss typo → nearest builtin via jaro distance" do
      assert fail_message(~S|(dedupe-by :id coll)|) =~ "dedupe"
    end

    test "underscore-for-hyphen → hyphen hint" do
      assert fail_message(~S|(my_var)|) =~ "hyphens not underscores"
    end

    test "multiple undefined vars each get their own hinted line" do
      msg = fail_message(~S|(do (map-vals inc {}) (map-keys f {}))|)
      assert msg =~ "Undefined variables:"
      assert msg =~ "update-vals"
      assert msg =~ "update-keys"
    end
  end

  describe "validate/2 carries the same hints out-of-band" do
    test "returns hinted strings, not bare names" do
      assert {:error, [msg]} = Lisp.validate(~S|(map-vals inc {"a" 1})|)
      assert msg =~ "update-vals"
    end

    test "valid program validates clean" do
      assert :ok = Lisp.validate(~S|(update-vals {"a" 1} inc)|)
    end
  end
end
