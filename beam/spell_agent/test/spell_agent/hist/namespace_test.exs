defmodule SpellAgent.Hist.NamespaceTest do
  @moduledoc """
  The `hist/*` PTC-Lisp tool surface (PLAN-001 W4): each verb is a thin adapter that
  returns plain data a program can pipe. Asserts the dispatch + arg-mapping contract
  for the verbs that need no live LLM (env/find/forms/def/cost/window/recall/spans).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Namespace, Recorder}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup do
    Store.clear(Memory)

    # seed: a find turn, an errored edit turn, a def turn
    # programs are PTC-Lisp AST terms (as Recorder stores them in `form`)
    a =
      Recorder.record_node(
        Memory,
        "s",
        %{
          program: {:tool_call, "find", %{target: "x"}},
          memory: %{},
          result: "found",
          tool_calls: [%{name: "find", args: %{}, result: "ok"}]
        },
        nil
      )

    b =
      Recorder.record_node(
        Memory,
        "s",
        %{
          program: {:tool_call, "edit", %{target: "y"}},
          memory: %{},
          result: "edited",
          tool_calls: [%{name: "edit", args: %{}, result: %{"err" => "boom"}}]
        },
        a.id
      )

    c =
      Recorder.record_node(
        Memory,
        "s",
        %{program: {:def, :plan, 1, %{}}, memory: %{plan: 1}, result: "planned"},
        b.id
      )

    {:ok, sess} = Store.fetch(Memory, {:session, "s"})
    Store.put(Memory, {:session, "s"}, %{sess | cursors: %{main: c.id}})

    %{verbs: Namespace.tools(Memory, "s"), nodes: {a, b, c}}
  end

  test "hist/env reconstitutes the def env", %{verbs: v} do
    assert v["hist/env"].(%{}) == %{plan: 1}
  end

  # The query lenses are now PTC-Lisp (PLAN-005) and return string-keyed projected
  # maps; the Elixir fast paths live under a `!` suffix and return atom-keyed maps.
  test "hist/tool_calls (PTC lens) filters tool calls by status", %{verbs: v} do
    errors = v["hist/tool_calls"].(%{"status" => "error"})
    assert [%{"tool" => "edit", "status" => "error"}] = errors
  end

  test "hist/tool_calls filters by tool name", %{verbs: v} do
    assert [%{"tool" => "find"}] = v["hist/tool_calls"].(%{"name" => "find"})
  end

  test "hist/find! (Elixir fast path) still returns atom-keyed tool calls", %{verbs: v} do
    assert [%{tool: "edit", status: :error}] = v["hist/find!"].(%{"status" => "error"})
  end

  test "hist/forms (PTC lens) matches turns whose program calls a tool", %{verbs: v} do
    nodes = v["hist/forms"].(%{"tool" => "edit"})
    # projected maps, string-keyed; assert via form_tools, not the raw AST
    assert Enum.all?(nodes, &("edit" in &1["form_tools"]))
    assert nodes != []
  end

  test "hist/forms! (Elixir fast path) returns nodes with the raw form AST", %{verbs: v} do
    nodes = v["hist/forms!"].(%{"tool" => "edit"})
    assert Enum.any?(nodes, &match?({:tool_call, "edit", _}, &1.form))
  end

  test "hist/defs (PTC lens) locates a definition", %{verbs: v} do
    assert [%{"seq" => _}] = v["hist/defs"].(%{"sym" => "plan"})
  end

  test "hist/window returns shown/trimmed id lists", %{verbs: v} do
    out = v["hist/window"].(%{"keep" => 1})
    assert %{shown: shown, trimmed: trimmed} = out
    assert is_list(shown) and is_list(trimmed)
  end

  test "hist/recall searches trimmed nodes", %{verbs: v} do
    # with keep 1, only the last is shown; the find/edit turns are trimmed
    hits = v["hist/recall"].(%{"like" => "found"})
    assert is_list(hits)
  end

  test "hist/sessions returns the unified listing as data", %{verbs: v} do
    rows = v["hist/sessions"].(%{})
    assert is_list(rows)
    assert Enum.any?(rows, &(&1.session_id == "s"))
  end

  test "hist/trace defaults to the current session; :session targets another", %{verbs: v} do
    # no arg -> this namespace's session ("s"), which has 3 recorded turns
    rows = v["hist/trace"].(%{})
    assert length(rows) == 3
    assert Enum.map(rows, & &1.seq) == Enum.sort(Enum.map(rows, & &1.seq))

    # an unknown session id -> empty, never a crash
    assert v["hist/trace"].(%{"session" => "nope"}) == []
  end

  test "hist/spans needs a node id and returns spans+cost", %{verbs: v, nodes: {a, _b, _c}} do
    out = v["hist/spans"].(%{"node" => a.id})
    assert %{spans: _, cost: %{input: _, output: _}} = out
  end

  test "unknown sym / missing args degrade to data, not crash", %{verbs: v} do
    assert v["hist/defs"].(%{"sym" => "nope"}) == []
    # no node arg -> empty list (no interior to show), never a crash
    assert v["hist/spans"].(%{}) == []
  end
end
