defmodule PtcRuntime.NilPoisonTest do
  @moduledoc """
  SPELL PATCH-6 (E7): strict accessors `get!`/`get-in!` — opt-in fail-loud
  map access that catches missing-key nil-poison before collection ops
  silently absorb it.

  Verifies through `PtcRunner.Lisp.run/2` that:
  - `get!`/`get-in!` succeed on present keys (including nil values)
  - `get!`/`get-in!` fail loud on absent keys
  - keyword/string/hyphen-aware resolution matches `get`/`get-in`
  - default `get`/`get-in` back-compat is UNCHANGED (nil-returning)
  - `get!` failure inside `psettled` settles as `{"err" => reason}`
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp

  defp run_ok(src, opts \\ []) do
    case Lisp.run(src, opts) do
      {:ok, step} -> {:ok, step.return}
      {:error, step} -> {:error, step.fail}
    end
  end

  describe "get! — strict single-key access" do
    test "present key returns value" do
      assert {:ok, 5} = run_ok(~S|(get! {"items" 5} "items")|)
    end

    test "absent key fails loud with message mentioning the key" do
      assert {:error, fail} = run_ok(~S|(get! {"items" 5} "absent")|)
      assert fail.message =~ "absent"
    end

    test "present key with nil VALUE returns nil (key exists, not absent)" do
      assert {:ok, nil} = run_ok(~S|(get! {"x" nil} "x")|)
    end

    test "missing key on empty map fails loud" do
      assert {:error, fail} = run_ok(~S|(get! {} "x")|)
      assert fail.message =~ "get!"
    end

    test "get! on nil container fails loud" do
      assert {:error, fail} = run_ok(~S|(get! nil :x)|)
      assert fail.message =~ "get!"
    end
  end

  describe "get! — keyword/hyphen-aware access" do
    test "keyword key resolves string value" do
      assert {:ok, 5} = run_ok(~S|(get! {"items" 5} :items)|)
    end

    test "hyphen key resolves underscore value" do
      assert {:ok, 5} = run_ok(~S|(get! {"turn_summaries" 5} :turn-summaries)|)
    end
  end

  describe "get-in! — strict nested access" do
    test "present path returns value" do
      assert {:ok, 5} = run_ok(~S|(get-in! {"a" {"b" 5}} ["a" "b"])|)
    end

    test "absent path segment fails loud naming the segment" do
      assert {:error, fail} = run_ok(~S|(get-in! {"a" {"b" 5}} ["a" "x"])|)
      assert fail.message =~ "x"
    end

    test "empty path returns the container" do
      assert {:ok, data} = run_ok(~S|(get-in! {"a" 1} [])|)
      assert data == %{"a" => 1}
    end

    test "nil container fails loud" do
      assert {:error, fail} = run_ok(~S|(get-in! nil ["a"])|)
      assert fail.message =~ "nil"
    end
  end

  describe "back-compat — default get/get-in unchanged" do
    test "get still returns nil for absent key" do
      assert {:ok, nil} = run_ok(~S|(get {"x" 1} "absent")|)
    end

    test "count of nil from absent get still returns 0" do
      assert {:ok, 0} = run_ok(~S|(count (get {"x" 1} "absent"))|)
    end
  end

  describe "psettled compose — get! failure settles as err" do
    test "psettled with get!: present key settles ok, missing key settles err" do
      src = ~S|(psettled (fn [x] (get! x "need")) [{"need" 1} {"other" 2}])|
      assert {:ok, [a, b]} = run_ok(src)
      assert a == %{"ok" => 1}
      assert Map.has_key?(b, "err")
      assert b["err"] =~ "need"
    end
  end
end
