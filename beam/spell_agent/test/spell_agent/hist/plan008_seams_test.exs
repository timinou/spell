defmodule SpellAgent.Hist.Plan008SeamsTest do
  @moduledoc """
  PLAN-008 consumer cutover: Hist now CONSUMES the structure the ptc_runner fork
  emits at the source (Moves A/B/C, projected onto the Turn) instead of
  reconstructing it from outside.

    * SEAM 1 — `Recorder` reads `turn.def_delta` for a node's `binds` (no
      snapshot diff); the deletion-by-omission class is unrepresentable.
    * SEAM 2 — the Step is frozen AT THE OWNER (`PtcRunner.Step.freeze/1`) before
      recording, so a node never holds a live handle and `Hist.Realize` is gone.
    * SEAM 3 — a node's `form` is the executed CoreAST (`turn.form`), so the
      `defs` / `form_tools` lens fields walk real structure (not a re-parsed
      string that silently yielded `[]`).

  These drive the PRIMARY (live-shape) path: turns carrying `def_delta` + `form`.
  The synthetic-turn FALLBACK path (no def_delta/form) is covered by
  `RecorderTest`.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Lens, Node, Recorder}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory
  alias PtcRunner.Lisp.{Handle, HandleStore}

  @store Memory

  setup do
    Store.clear(Memory)

    case Process.whereis(HandleStore) do
      nil -> start_supervised!({HandleStore, name: HandleStore})
      _ -> :ok
    end

    :ok
  end

  # A live-shape turn: carries def_delta (MOVE-A') and form (MOVE-C') the way the
  # agent loop now produces them. def names are BINARY (0.12 contract).
  defp live_turn(number, program, form, def_delta, memory, extra \\ %{}) do
    Map.merge(
      %{
        number: number,
        program: program,
        form: form,
        def_delta: def_delta,
        result: nil,
        prints: [],
        tool_calls: [],
        memory: memory,
        raw_response: "raw#{number}",
        success?: true,
        type: :normal
      },
      extra
    )
  end

  describe "SEAM 1 — binds sourced from turn.def_delta" do
    test "a node's binds is introduced ∪ changed from the runtime delta" do
      step = %PtcRunner.Step{
        turns: [
          live_turn(
            1,
            "(def x 1)",
            {:def, "x", 1, %{}},
            %{introduced: %{"x" => 1}, changed: %{}},
            %{"x" => 1}
          ),
          live_turn(
            2,
            "(def x 9)",
            {:def, "x", 9, %{}},
            %{introduced: %{}, changed: %{"x" => 9}},
            %{"x" => 9}
          )
        ]
      }

      Recorder.record_step(@store, "s", step)
      [n1, n2] = Store.list(@store, :node, "s") |> Enum.sort_by(& &1.seq)

      # introduced on turn 1, changed on turn 2 — both land in binds.
      assert n1.binds == %{"x" => 1}
      assert n2.binds == %{"x" => 9}
    end

    test "a def to nil is recorded (presence, not truthiness)" do
      step = %PtcRunner.Step{
        turns: [
          live_turn(
            1,
            "(def n nil)",
            {:def, "n", nil, %{}},
            %{introduced: %{"n" => nil}, changed: %{}},
            %{"n" => nil}
          )
        ]
      }

      Recorder.record_step(@store, "s", step)
      [n1] = Store.list(@store, :node, "s")

      assert Map.has_key?(n1.binds, "n")
      assert n1.binds["n"] == nil
    end

    test "no binds value is ever a deletion sentinel (B1 class unrepresentable)" do
      step = %PtcRunner.Step{
        turns: [
          live_turn(
            1,
            "(def a 1)",
            {:def, "a", 1, %{}},
            %{introduced: %{"a" => 1}, changed: %{}},
            %{"a" => 1}
          )
        ]
      }

      Recorder.record_step(@store, "s", step)
      [n1] = Store.list(@store, :node, "s")

      refute Enum.any?(n1.binds, fn {_k, v} -> v == :__hist_deleted__ end)
    end

    test "apply_binds is a plain merge (folds the delta onto the env)" do
      assert Node.apply_binds(%{"x" => 1}, %{"y" => 2}) == %{"x" => 1, "y" => 2}
      assert Node.apply_binds(%{"x" => 1}, %{"x" => 9}) == %{"x" => 9}
    end
  end

  describe "SEAM 2 — handles realized at the owner (Step frozen before record)" do
    test "a frozen step records a realized value, never a live handle" do
      big = %{"rows" => Enum.to_list(1..500)}
      handle = HandleStore.put(HandleStore, big, make_ref())

      step =
        %PtcRunner.Step{
          turns: [
            live_turn(
              1,
              "(def d (tool/x))",
              {:def, "d", {:tool_call, "x", []}, %{}},
              %{introduced: %{"d" => handle}, changed: %{}},
              %{"d" => handle},
              %{result: handle, tool_calls: [%{name: "x", args: %{}, result: handle}]}
            )
          ]
        }

      # The owner freezes BEFORE recording (as Session.record_history does).
      frozen = PtcRunner.Step.freeze(step)
      Recorder.record_step(@store, "s", frozen)
      [n1] = Store.list(@store, :node, "s")

      refute Handle.handle?(n1.result)
      assert n1.result == big
      refute Handle.handle?(n1.binds["d"])
      assert n1.binds["d"] == big
      [see] = n1.sees
      assert see.result == big
    end

    test "an unrealizable handle is tombstoned with the frozen marker" do
      exec_id = make_ref()
      handle = HandleStore.put(HandleStore, %{"gone" => 1}, exec_id)
      HandleStore.release(HandleStore, exec_id)

      step =
        %PtcRunner.Step{
          turns: [
            live_turn(
              1,
              "(def d (tool/x))",
              {:def, "d", {:tool_call, "x", []}, %{}},
              %{introduced: %{}, changed: %{}},
              %{},
              %{result: handle}
            )
          ]
        }

      frozen = PtcRunner.Step.freeze(step)
      Recorder.record_step(@store, "s", frozen)
      [n1] = Store.list(@store, :node, "s")

      assert Handle.unrealized?(n1.result)
      assert {:__frozen_unrealized__, _reason, _meta} = n1.result
    end
  end

  describe "SEAM 3 — lens walks the executed CoreAST in turn.form" do
    test "defs and form_tools are non-empty, sourced from the real AST" do
      # A form that defines x and calls tool/foo — the once-silent-[] case.
      form =
        {:do,
         [
           {:def, "x", 1, %{}},
           {:tool_call, "foo", []}
         ]}

      step = %PtcRunner.Step{
        turns: [
          live_turn(
            1,
            "(do (def x 1) (tool/foo {}))",
            form,
            %{introduced: %{"x" => 1}, changed: %{}},
            %{"x" => 1}
          )
        ]
      }

      Recorder.record_step(@store, "s", step)
      [n1] = Store.list(@store, :node, "s")

      # Node.form is the real AST, not the source string.
      refute is_binary(n1.form)
      assert "x" in Lens.def_names(n1.form)
      assert "foo" in Lens.tool_call_names(n1.form)
    end

    test "a tool call nested in a let is still surfaced" do
      form = {:let, [["r", {:tool_call, "bar", []}]], [{:var, "r"}]}

      step = %PtcRunner.Step{
        turns: [
          live_turn(1, "(let [r (tool/bar {})] r)", form, %{introduced: %{}, changed: %{}}, %{})
        ]
      }

      Recorder.record_step(@store, "s", step)
      [n1] = Store.list(@store, :node, "s")

      assert "bar" in Lens.tool_call_names(n1.form)
    end

    test "a synthetic turn (no form) falls back to the program string without crashing" do
      synthetic = %{
        number: 1,
        program: "(def x 1)",
        result: nil,
        prints: [],
        tool_calls: [],
        memory: %{x: 1},
        raw_response: "r",
        success?: true,
        type: :normal
      }

      step = %PtcRunner.Step{turns: [synthetic]}
      Recorder.record_step(@store, "s", step)
      [n1] = Store.list(@store, :node, "s")

      # form falls back to the string; lens walkers return [] without raising.
      assert n1.form == "(def x 1)"
      assert Lens.def_names(n1.form) == []
      assert Lens.tool_call_names(n1.form) == []
    end
  end
end
