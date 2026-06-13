defmodule PtcRuntime.ProbeTest do
  @moduledoc """
  `(probe "title" expr "title" expr ...)` — a labelled, ordered sequence of
  checks. Exercised directly through `PtcRunner.Lisp.run/2` (no peer / bridge)
  so the language semantics are pinned independent of transport, mirroring the
  try/catch and psettled suites.

  Invariants:
    * result is the sentinel map `{"__probe__" => [[title, value], ...]}`,
      ORDERED (a vector of pairs — a map would key-sort and lose intent order);
    * a failing check SETTLES in place as `{"err" => reason}` and the rest still
      run (sequential analogue of psettled);
    * ctx threads across checks so a `def` in one is visible to the next;
    * a global safety limit is NEVER swallowed (same boundary as try/psettled).
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp

  defp tools do
    %{
      "boom" => fn _ -> raise PtcRunner.ToolExecutionError, tool_name: "boom", message: "nope" end
    }
  end

  defp run!(src, opts \\ []) do
    case Lisp.run(src, Keyword.merge([tools: tools()], opts)) do
      {:ok, step} -> {:ok, step.return}
      {:error, step} -> {:error, step.fail}
    end
  end

  describe "probe — shape and order" do
    test "returns the sentinel map with ordered [title value] pairs" do
      assert {:ok, %{"__probe__" => rows}} =
               run!(~S|(probe "a" (+ 1 2) "b" (* 3 4))|)

      assert rows == [["a", 3], ["b", 12]]
    end

    test "order is preserved regardless of title sort order" do
      assert {:ok, %{"__probe__" => rows}} =
               run!(~S|(probe "zebra" 1 "apple" 2 "mango" 3)|)

      # A map would sort to apple/mango/zebra; the vector keeps insertion order.
      assert rows == [["zebra", 1], ["apple", 2], ["mango", 3]]
    end

    test "a single check is fine" do
      assert {:ok, %{"__probe__" => [["only", 42]]}} = run!(~S|(probe "only" 42)|)
    end

    test "structured values pass through as data" do
      assert {:ok, %{"__probe__" => [["m", %{"a" => 1, "b" => [2, 3]}]]}} =
               run!(~S|(probe "m" {:a 1 :b [2 3]})|)
    end
  end

  describe "probe — per-check settling" do
    test "a (fail v) check settles as {\"err\" => v} without aborting the rest" do
      assert {:ok, %{"__probe__" => rows}} =
               run!(~S|(probe "ok" 1 "bad" (fail "boom") "after" 2)|)

      assert rows == [["ok", 1], ["bad", %{"err" => "boom"}], ["after", 2]]
    end

    test "a raised tool failure settles, later checks still run" do
      assert {:ok, %{"__probe__" => rows}} =
               run!(~S|(probe "bad" (tool/boom {}) "after" 99)|)

      assert [["bad", %{"err" => msg}], ["after", 99]] = rows
      assert is_binary(msg)
    end

    test "an unbound-var check settles with a readable reason" do
      assert {:ok, %{"__probe__" => rows}} =
               run!(~S|(probe "bad" nope "after" 1)|)

      assert [["bad", %{"err" => err}], ["after", 1]] = rows
      assert is_binary(err)
    end
  end

  describe "probe — ctx threading" do
    test "a def in one check is visible to the next" do
      assert {:ok, %{"__probe__" => rows}} =
               run!(~S|(probe "bind" (do (def n 7) n) "use" (+ n 1))|)

      assert rows == [["bind", 7], ["use", 8]]
    end

    test "ctx is preserved across a settled failure" do
      assert {:ok, %{"__probe__" => rows}} =
               run!(~S|(probe "bind" (do (def n 5) n) "boom" (fail "x") "use" (* n 2))|)

      assert rows == [["bind", 5], ["boom", %{"err" => "x"}], ["use", 10]]
    end
  end

  describe "probe — arity validation" do
    test "an odd number of forms is a clean analyze error" do
      assert {:error, _} = run!(~S|(probe "a" 1 "b")|)
    end
  end

  describe "probe — discovery" do
    test "is discoverable via apropos" do
      assert {:ok, step} = Lisp.run(~S|(apropos "probe")|, tools: tools())
      lines = step.return
      assert Enum.any?(lines, &String.contains?(&1, "probe"))
    end
  end
end
