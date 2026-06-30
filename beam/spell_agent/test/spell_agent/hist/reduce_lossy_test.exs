defmodule SpellAgent.Hist.ReduceLossyTest do
  @moduledoc """
  Lossy-but-restorable tier contract (PLAN-018 W6): result-spill rewrites an
  over-threshold, RESTORABLE node.result into a {node_id, path, digest} stub that
  sheds tape bytes while staying recoverable (the full node is untouched in the
  store). Non-restorable (external/mutation) and failed results are never spilled;
  the env proof still holds (spill touches result, not binds).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Node, Reduce, Spill, Refold}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp node(seq, opts) do
    %Node{
      id: "n#{seq}",
      session: "s",
      seq: seq,
      parent_id: if(seq > 0, do: "n#{seq - 1}"),
      status: Keyword.get(opts, :status, :ok),
      form: Keyword.get(opts, :form, nil),
      form_src: Keyword.get(opts, :form_src, "(noop)"),
      binds: Keyword.get(opts, :binds, %{}),
      result: Keyword.get(opts, :result, nil)
    }
  end

  # A big restorable read program (cat) + a big result that exceeds the threshold.
  defp big_read(seq, result) do
    node(seq, form: {:tool_call, "sh", [{:map, [{{:keyword, "argv"}, {:vector, [{:string, "cat"}, {:string, "f"}]}}]}]}, result: result)
  end

  @big String.duplicate("x", 4_000)

  describe "result-spill" do
    test "an over-threshold restorable result is spilled to a stub" do
      slice = [big_read(0, @big)]
      [reduced] = Spill.spill(slice)

      assert %{"spilled" => true, "node_id" => "n0", "digest" => d, "bytes" => b} = reduced.result
      assert is_binary(d)
      assert b == byte_size(@big)
    end

    test "the spilled node is recoverable from the untouched store node (restorability)" do
      # the ORIGINAL node stays in the store; the stub points back via node_id.
      original = big_read(0, @big)
      Store.put(Memory, {:node, "s", original.id}, original)

      [spilled] = Spill.spill([original])
      node_id = spilled.result["node_id"]

      # the restore path: fetch the original node by the stub's node_id.
      {:ok, restored} = Store.fetch(Memory, {:node, "s", node_id})
      assert restored.result == @big
    end

    test "a small result is kept verbatim (not worth a stub)" do
      slice = [big_read(0, "tiny")]
      [reduced] = Spill.spill(slice)
      assert reduced.result == "tiny"
    end
  end

  describe "no-spill invariants" do
    test "an external program's big result is NEVER spilled (no path back)" do
      external = node(0, form: {:tool_call, "sh", [{:map, [{{:keyword, "argv"}, {:vector, [{:string, "date"}]}}]}]}, result: @big)
      [reduced] = Spill.spill([external])
      # date is :external -> not restorable -> kept verbatim.
      assert reduced.result == @big
    end

    test "a mutation program's big result is NEVER spilled" do
      mutation = node(0, form: {:tool_call, "sh", [{:map, [{{:keyword, "argv"}, {:vector, [{:string, "rm"}, {:string, "f"}]}}]}]}, result: @big)
      [reduced] = Spill.spill([mutation])
      assert reduced.result == @big
    end

    test "a FAILED turn's big result is kept verbatim (errors exempt)" do
      failed = %{big_read(0, @big) | status: :error}
      [reduced] = Spill.spill([failed])
      assert reduced.result == @big
    end
  end

  describe "the lossy tier composes with the env proof" do
    test "fold_env(lossy(slice)) == fold_env(slice)" do
      slice = [
        node(0, binds: %{x: 1}, form: {:def, :x, {:literal, 1}, %{}}),
        big_read(1, @big)
      ]

      assert Reduce.fold_env(Reduce.lossy(slice)) == Reduce.fold_env(slice)
    end

    test "lossy refolds to a provider-valid tape with the stub as the tool result" do
      slice = [big_read(0, @big)]
      tape = slice |> Reduce.lossy() |> Refold.slice_to_tape()

      # the tool_result content is the JSON-encoded stub, not the 4KB payload.
      [%{role: :tool, content: content}] = Enum.filter(tape, &match?(%{role: :tool}, &1))
      decoded = Jason.decode!(content)
      assert decoded["result"]["spilled"] == true
    end
  end

  describe "recite (tail goal-restatement)" do
    alias SpellAgent.Hist.{Namespace, Recorder}

    test "projects the opening goal + progress as a tail block" do
      a = Recorder.record_node(Memory, "r", %{prompt: "fix the bug", program: "(tool/sh {:argv [\"rg\" \"x\"]})", result: "ok"}, nil)
      Recorder.record_node(Memory, "r", %{program: "(tool/sh {:argv [\"cat\" \"f\"]})", result: "ok"}, a.id)

      verbs = Namespace.tools(Memory, "r")
      text = verbs["hist/recite"].(%{})

      assert text =~ "Current objective"
      assert text =~ "fix the bug"
      assert text =~ "Progress:"
    end

    test "an empty session recites nothing" do
      Store.put(Memory, {:session, "empty"}, %SpellAgent.Hist.Session{id: "empty", cursors: %{}})
      verbs = Namespace.tools(Memory, "empty")
      assert verbs["hist/recite"].(%{}) == ""
    end
  end
end
