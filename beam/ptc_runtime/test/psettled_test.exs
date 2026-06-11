defmodule PtcRuntime.PsettledTest do
  @moduledoc """
  SPELL PATCH-1 (D-4): settled parallel map + errors-as-values prelude.

  Exercises the vendored fork's `psettled` builtin and the `ok?` / `err?` /
  `unwrap-or` predicates directly through `PtcRunner.Lisp.run/2` (no peer /
  bridge), so the language semantics are pinned independent of transport.
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp

  # A tool catalog where `ok` squares its arg and `boom` always raises a
  # ToolExecutionError — the canonical per-element failure psettled must catch.
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

  describe "psettled — settled collection semantics" do
    test "all-success: every element wrapped {\"ok\" => value}, order preserved" do
      assert {:ok, results} = run!(~S|(psettled (fn [x] (tool/sq {:n x})) [1 2 3])|)
      assert results == [%{"ok" => 1}, %{"ok" => 4}, %{"ok" => 9}]
    end

    test "mixed: a failing element becomes {\"err\" => reason}, batch survives" do
      # Element 2 calls (tool/boom) and fails; the other two still settle.
      src = ~S|(psettled (fn [x] (if (= x 2) (tool/boom {}) (tool/sq {:n x}))) [1 2 3])|
      assert {:ok, [a, b, c]} = run!(src)
      assert a == %{"ok" => 1}
      assert Map.has_key?(b, "err")
      assert b["err"] =~ "boom"
      assert c == %{"ok" => 9}
    end

    test "fail signal inside a worker settles as an err, does not abort" do
      src = ~S|(psettled (fn [x] (if (= x 2) (fail "bad") x)) [1 2 3])|
      assert {:ok, [%{"ok" => 1}, err, %{"ok" => 3}]} = run!(src)
      assert Map.has_key?(err, "err")
    end

    test "contrast: pmap aborts the whole run on the same failing element" do
      src = ~S|(pmap (fn [x] (if (= x 2) (tool/boom {}) (tool/sq {:n x}))) [1 2 3])|
      assert {:error, _fail} = run!(src)
    end

    test "SAFETY: a per-worker heap-cap kill ABORTS psettled (never settles)" do
      # The highest-stakes invariant: a resource-exhaustion kill must abort the
      # whole run even under psettled — a program must not be able to swallow a
      # global safety limit as an {"err"} value. A worker that builds a large
      # binary under a tight per-worker heap cap is killed by the BEAM; the run
      # must surface :memory_exceeded, not a settled list.
      src = ~S|(psettled (fn [x] (reduce (fn [acc _] (str acc "xxxxxxxxxx")) "" (range 0 100000))) [1 2 3])|
      assert {:error, fail} = run!(src, worker_max_heap: 2_000, max_parallel_workers: 4)
      assert fail.reason in [:memory_exceeded, :timeout, :parallel_capacity_exceeded]
    end

    test "empty collection yields []" do
      assert {:ok, []} = run!(~S|(psettled (fn [x] x) [])|)
    end

    test "arity error is a compile/analysis failure" do
      assert {:error, _} = run!(~S|(psettled (fn [x] x))|)
    end
  end

  describe "errors-as-values prelude" do
    test "ok? / err? classify settled maps" do
      assert {:ok, true} = run!(~S|(ok? {"ok" 1})|)
      assert {:ok, false} = run!(~S|(ok? {"err" "x"})|)
      assert {:ok, true} = run!(~S|(err? {"err" "x"})|)
      assert {:ok, false} = run!(~S|(err? {"ok" 1})|)
      assert {:ok, false} = run!(~S|(ok? 42)|)
      assert {:ok, false} = run!(~S|(err? 42)|)
    end

    test "keyword and string map literals are the same string-keyed map" do
      # {:ok v} interns its keyword key to the binary "ok" (:ok not in the
      # bounded atom vocab, #953), so the keyword form classifies identically
      # to the string form — ok?/err?/unwrap-or are string-keyed only.
      assert {:ok, true} = run!(~S|(ok? {:ok 1})|)
      assert {:ok, true} = run!(~S|(err? {:err "x"})|)
      assert {:ok, 7} = run!(~S|(unwrap-or {:ok 7} 0)|)
    end

    test "unwrap-or returns the value for ok, the default otherwise" do
      assert {:ok, 7} = run!(~S|(unwrap-or {"ok" 7} 0)|)
      assert {:ok, 0} = run!(~S|(unwrap-or {"err" "boom"} 0)|)
      # A novel keyword externalizes to a plain binary (fork's bounded-atom design).
      assert {:ok, "none"} = run!(~S|(unwrap-or 42 :none)|)
    end

    test "end-to-end: filter ok?, unwrap, sum the survivors" do
      src = ~S"""
      (->> (psettled (fn [x] (if (= x 2) (tool/boom {}) (tool/sq {:n x}))) [1 2 3])
           (filter ok?)
           (map (fn [r] (unwrap-or r 0)))
           (reduce + 0))
      """

      # survivors: 1 (=1²) and 9 (=3²) → 10
      assert {:ok, 10} = run!(src)
    end
  end
end
