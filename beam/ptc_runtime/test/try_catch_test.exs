defmodule PtcRuntime.TryCatchTest do
  @moduledoc """
  SPELL PATCH-8 (FEAT-812): Clojure-shaped `(try body (catch e h) (finally f))`.

  Exercises the vendored fork's `try` special form directly through
  `PtcRunner.Lisp.run/2` (no peer / bridge), so the language semantics are
  pinned independent of transport — mirrors the PATCH-1 psettled suite.

  The highest-stakes invariant has its own describe block: a `try` must NEVER
  let a program swallow a global safety limit (heap / timeout / capacity) — the
  same boundary `psettled` enforces.
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp

  # `sq` squares its arg; `boom` always raises a ToolExecutionError — the
  # canonical tool failure a catch handler must be able to trap.
  defp tools do
    %{
      "sq" => fn %{"n" => n} -> n * n end,
      "boom" => fn _ -> raise PtcRunner.ToolExecutionError, tool_name: "boom", message: "nope" end
    }
  end

  defp run!(src, opts \\ []) do
    case Lisp.run(src, Keyword.merge([tools: tools()], opts)) do
      {:ok, step} -> {:ok, step.return}
      {:error, step} -> {:error, step.fail}
    end
  end

  describe "try — normal completion" do
    test "no error: body value is returned, catch is not run" do
      assert {:ok, 42} = run!(~S|(try 42 (catch e 99))|)
    end

    test "multi-expression body returns the last value" do
      assert {:ok, 3} = run!(~S|(try 1 2 3 (catch e :nope))|)
    end

    test "try with no catch and no finally is just its body" do
      assert {:ok, 7} = run!(~S|(try 7)|)
    end
  end

  describe "try/catch — error capture" do
    test "a raised runtime error (div by zero) is caught; e bound to message" do
      assert {:ok, msg} = run!(~S|(try (/ 1 0) (catch e e))|)
      assert is_binary(msg)
    end

    test "an unbound variable error is caught as a string message" do
      assert {:ok, caught} = run!(~S|(try (+ undefined-thing 1) (catch e {"caught" e}))|)
      assert is_binary(caught["caught"])
    end

    test "a tool failure is caught; handler value replaces the body" do
      assert {:ok, "recovered"} =
               run!(~S|(try (tool/boom {}) (catch e "recovered"))|)
    end

    test "the catch var is bound only inside the handler (handler-local scope)" do
      # `e` must not leak past the try; referencing it after should be unbound.
      assert {:error, _} = run!(~S|(do (try (fail "x") (catch e e)) e)|)
    end

    test "(fail v) is caught and binds the RAW value v (not a string)" do
      assert {:ok, %{"code" => 7}} =
               run!(~S|(try (fail {:code 7}) (catch e e))|)
    end

    test "a catch handler can itself compute / call tools" do
      assert {:ok, 25} =
               run!(~S|(try (tool/boom {}) (catch e (tool/sq {:n 5})))|)
    end

    test "no error means the raw (fail) path is not taken" do
      assert {:ok, 1} = run!(~S|(try 1 (catch e 2))|)
    end
  end

  describe "try/finally — guaranteed cleanup" do
    test "finally runs on normal completion; its value is discarded" do
      # finally returns 999 but the try result is the body value 1.
      assert {:ok, 1} = run!(~S|(try 1 (finally 999))|)
    end

    test "finally runs after a caught error; try yields the handler value" do
      # :handled externalizes to the binary "handled" (bounded-atom design, #953).
      assert {:ok, "handled"} =
               run!(~S|(try (fail "boom") (catch e :handled) (finally 0))|)
    end

    test "a (fail) with no catch propagates unchanged (finally still runs)" do
      # No catch clause: `(fail v)` is a control-flow throw that bubbles to the
      # program boundary, where it surfaces as the {:__ptc_fail__, v} sentinel
      # (same as a bare top-level `(fail ...)`). finally runs as it passes.
      assert {:ok, {:__ptc_fail__, "boom"}} =
               run!(~S|(try (fail "boom") (finally 0))|)
    end

    test "a raised error with no catch but a finally propagates as {:error}" do
      # The {:error, reason} tuple channel (no catch) propagates the error.
      assert {:error, _} = run!(~S|(try (/ 1 0) (finally 0))|)
    end
  end

  describe "try + return — non-local return bubbles through" do
    test "(return v) inside try bubbles to the program boundary (not caught)" do
      # return is control flow, not an error: it is NOT trapped by catch. At the
      # program boundary a top-level return surfaces as {:__ptc_return__, v}.
      assert {:ok, {:__ptc_return__, 5}} = run!(~S|(try (return 5) (catch e :nope))|)
    end

    test "return bubbles through finally (finally still runs)" do
      assert {:ok, {:__ptc_return__, 5}} =
               run!(~S|(try (return 5) (catch e :nope) (finally 0))|)
    end
  end

  describe "try — composition" do
    test "nested try: inner catch handles, outer sees the recovered value" do
      assert {:ok, 100} =
               run!(~S|(try (try (fail "inner") (catch e 100)) (catch e -1))|)
    end

    test "try inside a closure captures correctly (catch var not free)" do
      src = ~S|((fn [x] (try (fail x) (catch e e))) "boom")|
      assert {:ok, "boom"} = run!(src)
    end

    test "try usable as an expression in a let binding" do
      assert {:ok, 9} =
               run!(~S|(let [v (try (tool/boom {}) (catch e (tool/sq {:n 3})))] v)|)
    end
  end

  describe "SAFETY — try cannot swallow a global safety limit" do
    test "a heap-cap kill inside try ABORTS the run (never caught)" do
      # The highest-stakes invariant: a resource-exhaustion kill must propagate
      # past a surrounding catch. A worker that builds a large binary under a
      # tight per-worker heap cap is killed; even wrapped in (try ... (catch e
      # ...)) the run must surface :memory_exceeded, not the handler value.
      src = ~S"""
      (psettled
        (fn [x]
          (try
            (reduce (fn [acc _] (str acc "xxxxxxxxxx")) "" (range 0 100000))
            (catch e "SWALLOWED")))
        [1 2 3])
      """

      assert {:error, fail} = run!(src, worker_max_heap: 2_000, max_parallel_workers: 4)
      assert fail.reason in [:memory_exceeded, :timeout, :parallel_capacity_exceeded]
    end
  end

  describe "try — analysis errors" do
    test "catch without a binding symbol is an analysis failure" do
      assert {:error, _} = run!(~S|(try 1 (catch 2 3))|)
    end
  end
end
