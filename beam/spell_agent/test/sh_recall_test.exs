defmodule SpellAgent.ShRecallTest do
  @moduledoc """
  Shell-command recall (PLAN-011 W6) — the deferred 'one recall layer' query.

  `hist/forms {:shell "rg"}` finds turns whose program ran a shell command with
  the given head (via tool/sh or tool/sh-pipe), the shell analogue of
  `{:tool "edit"}`. Verifies shell_heads extraction, the Query.forms {:shell}
  matcher, the Namespace dispatch, and PTC==Elixir parity for the shell lens.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Lens, Namespace, Query, Recorder, Store}
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)
    # The ToolRegistry is a named singleton shared across tests; clear durable
    # tool state so a tool defined elsewhere cannot leak into a recall here.
    case SpellAgent.ToolRegistry.start_link([]) do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> :ok
    end

    for e <- SpellAgent.ToolRegistry.all(), do: SpellAgent.ToolRegistry.remove(e.name)
    :ok
  end

  defp core(src) do
    {:ok, ast} = PtcRunner.Lisp.Parser.parse(src)
    {:ok, c} = PtcRunner.Lisp.Analyze.analyze(ast)
    c
  end

  defp node(program, parent_id) do
    Recorder.record_node(Memory, "s", %{program: program, memory: %{}, tool_calls: []}, parent_id)
  end

  describe "shell_heads extraction" do
    test "extracts the argv head of a tool/sh call" do
      assert Lens.shell_heads(core(~S|(tool/sh {:argv ["rg" "-l" "TODO"]})|)) == ["rg"]
    end

    test "extracts each stage head of a tool/sh-pipe call" do
      assert Lens.shell_heads(core(~S|(tool/sh-pipe {:stages [["cat" "f"] ["grep" "x"]]})|)) ==
               ["cat", "grep"]
    end

    test "finds heads nested in a threading macro" do
      assert Lens.shell_heads(core(~S|(->> (tool/sh {:argv ["git" "log"]}) :lines)|)) == ["git"]
    end

    test "a non-literal argv head is skipped (not statically known)" do
      assert Lens.shell_heads(core(~S|(tool/sh {:argv [cmd "x"]})|)) == []
    end

    test "a non-shell tool call yields no heads" do
      assert Lens.shell_heads(core(~S|(tool/edit {:target "a.ex"})|)) == []
    end
  end

  describe "Query.forms {:shell, head}" do
    test "returns turns running the given command head" do
      a = node(core(~S|(tool/sh {:argv ["rg" "TODO"]})|), nil)
      _b = node(core(~S|(tool/edit {:target "x"})|), a.id)
      c = node(core(~S|(tool/sh {:argv ["rg" "FIXME"]})|), a.id)

      hits = Query.forms(Memory, "s", {:shell, "rg"})
      ids = Enum.map(hits, & &1.id) |> Enum.sort()
      assert ids == Enum.sort([a.id, c.id])
    end

    test "does not match a different command head" do
      a = node(core(~S|(tool/sh {:argv ["rg" "TODO"]})|), nil)
      assert Query.forms(Memory, "s", {:shell, "grep"}) == []
      assert [_] = Query.forms(Memory, "s", {:shell, "rg"})
      _ = a
    end
  end

  describe "namespace + PTC lens" do
    setup do
      a = node(core(~S|(tool/sh {:argv ["rg" "TODO"]})|), nil)
      _b = node(core(~S|(tool/sh-pipe {:stages [["git" "log"] ["head"]]})|), a.id)
      :ok
    end

    test "hist/forms {:shell ...} (Elixir fast path) finds shell turns" do
      verbs = Namespace.tools(Memory, "s")
      rg = verbs["hist/forms!"].(%{"shell" => "rg"})
      assert length(rg) == 1
      git = verbs["hist/forms!"].(%{"shell" => "git"})
      assert length(git) == 1
    end

    test "the PTC forms lens matches the Elixir fast path for :shell (same IDs)" do
      src = Map.fetch!(Lens.sources(), "forms")
      ptc = Lens.run(Memory, "s", src, %{"shell" => "rg"})
      elixir = Query.forms(Memory, "s", {:shell, "rg"})
      # Parity is on the NODES, not just the count: assert equal id lists in
      # seq order (the same standard the :tool parity test uses).
      ptc_ids = Enum.map(ptc, &(&1["id"] || &1[:id]))
      elixir_ids = Enum.map(elixir, & &1.id)
      assert ptc_ids == elixir_ids
    end

    test ":tool query still works (no regression to Lisp recall)" do
      verbs = Namespace.tools(Memory, "s")
      # both seeded turns call a tool (sh / sh-pipe); query by tool name
      assert length(verbs["hist/forms!"].(%{"tool" => "sh"})) == 1
      assert length(verbs["hist/forms!"].(%{"tool" => "sh-pipe"})) == 1
    end
  end
end
