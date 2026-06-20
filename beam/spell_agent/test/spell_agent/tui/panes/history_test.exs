defmodule SpellAgent.Tui.Panes.HistoryTest do
  @moduledoc """
  Unit tests for the History pane (PLAN-003 SEAM 3) — the durable scrollback.

  The pane's contract is a pure fold `(assigns -> vm)`: given a `:hist_session` +
  `:hist_store` in assigns, `project/2` reconstitutes the conversation and folds
  its interleaved transcript into a list view-model; absent a session it yields the
  empty state. These pin that contract with an injected `Store.Memory`, never the
  live store.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.Panes.History
  alias SpellAgent.Hist.{Recorder, Store}
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    :ok
  end

  defp seed(sid, prompt, result, parent) do
    n =
      Recorder.record_node(
        Memory,
        sid,
        %{program: "(work)", memory: %{}, result: result, prompt: prompt},
        parent
      )

    {:ok, sess} = Store.fetch(Memory, {:session, sid})
    Store.put(Memory, {:session, sid}, %{sess | cursors: Map.put(sess.cursors, :main, n.id)})
    n
  end

  defp assigns(sid), do: %{hist_session: sid, hist_store: Memory}

  test "project folds a session's transcript into interleaved user/assistant lines" do
    a = seed("s", "map auth", "Mapped it.", nil)
    seed("s", "fix bug", "Fixed it.", a.id)

    vm = History.project(%{}, assigns("s"))

    assert vm.empty? == false
    assert vm.count == 4
    assert Enum.map(vm.lines, & &1.role) == [:user, :assistant, :user, :assistant]
    assert Enum.map(vm.lines, & &1.text) == ["map auth", "Mapped it.", "fix bug", "Fixed it."]
  end

  test "project yields the empty state when no session is bound" do
    vm = History.project(%{}, %{hist_store: Memory})
    assert vm.empty?
    assert vm.lines == []
  end

  test "project yields the empty state for an unknown session id" do
    vm = History.project(%{}, assigns("ghost"))
    assert vm.empty?
  end

  test "fold/1 maps message maps to role+text line maps" do
    msgs = [%{role: :user, content: "hi"}, %{role: :assistant, content: "yo"}]

    assert History.fold(msgs) == %{
             lines: [%{role: :user, text: "hi"}, %{role: :assistant, text: "yo"}],
             count: 2,
             empty?: false
           }
  end

  test "view returns a :history widget descriptor carrying the lines + scroll" do
    seed("s", "p", "a", nil)
    vm = History.project(%{}, assigns("s"))

    [{{:history, desc}, _rect}] =
      History.view(%{vm: vm, rect: :r, assigns: %{}, focused?: true})

    assert desc.lines == vm.lines
    assert desc.empty? == false
    assert desc.focused? == true
    assert desc.scroll == 0
  end

  test "the pane wakes on a finished turn" do
    assert [[:turn, :stop]] = History.events()
  end

  # BUG-004 T1: a raising store must DEGRADE to empty state, never crash render.
  test "project degrades to the empty state when the store raises" do
    defmodule RaisingStore do
      @behaviour SpellAgent.Hist.Store
      def put(_, _), do: raise("down")
      def fetch(_), do: raise("down")
      def delete(_), do: raise("down")
      def list(_, _ \\ nil), do: raise("down")
      def clear, do: raise("down")
    end

    vm = History.project(%{}, %{hist_session: "s", hist_store: RaisingStore})
    assert vm.empty?
    assert vm.lines == []
  end
end
