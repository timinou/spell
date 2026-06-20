defmodule SpellAgent.Hist.ProvenanceLensTest do
  @moduledoc """
  FUP-001 — the provenance lens: "where was `x` FIRST bound, and which later turns
  rebound it?" answered from the runtime-emitted def-delta (MOVE-A/A'), with NO env
  folding or snapshot diffing.

  Cassette-backed: each test replays a recorded session fixture
  (`test/fixtures/hist/*.cassette`) into the store, so the assertions run against
  history that was serialized to disk and read back — not an in-memory object the
  test just built. See `SpellAgent.HistCassette`.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.{Lens, Namespace}
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.HistCassette

  @store Memory

  # A live-shape turn: carries the runtime def_delta (introduced/changed, binary
  # names) the loop now produces. This is what MOVE-A'/C' put on the Turn.
  defp turn(program, def_delta, memory) do
    %{
      program: program,
      def_delta: def_delta,
      memory: memory,
      tool_calls: [],
      prints: [],
      raw_response: "raw"
    }
  end

  # A session where: turn1 defines plan+x, turn2 rebinds plan, turn3 rebinds plan
  # again and introduces y. Provenance of `plan` = born@1, rebound@[2,3].
  defp cassette_turns do
    [
      turn(
        "(do (def plan 1) (def x 0))",
        %{introduced: %{"plan" => 1, "x" => 0}, changed: %{}},
        %{"plan" => 1, "x" => 0}
      ),
      turn("(def plan 2)", %{introduced: %{}, changed: %{"plan" => 2}}, %{"plan" => 2, "x" => 0}),
      turn("(do (def plan 3) (def y 9))", %{introduced: %{"y" => 9}, changed: %{"plan" => 3}}, %{
        "plan" => 3,
        "x" => 0,
        "y" => 9
      })
    ]
  end

  setup do
    %{nodes: nodes} = HistCassette.ensure("provenance_basic", "prov", cassette_turns(), @store)
    {:ok, nodes: nodes, verbs: Namespace.tools(@store, "prov")}
  end

  test "the cassette fixture is written to disk and replays deterministically", %{nodes: nodes} do
    assert File.exists?(HistCassette.path("provenance_basic"))
    # Reload a SECOND time into a clean store: same node ids, same order.
    reload = HistCassette.load("provenance_basic", @store)
    assert Enum.map(reload.nodes, & &1.id) == Enum.map(nodes, & &1.id)
  end

  test "introduced is the FIRST-binding set; rebinds are excluded", %{nodes: [n1, n2, n3]} do
    # turn 1 first-bound plan and x; turn 2 rebound plan (no new intro);
    # turn 3 first-bound y (plan was a rebind there).
    assert Enum.sort(n1.introduced) == ["plan", "x"]
    assert n2.introduced == []
    assert n3.introduced == ["y"]
  end

  test "hist/provenance traces a symbol to its birth + rebinds", %{
    verbs: verbs,
    nodes: [n1, n2, n3]
  } do
    result = verbs["hist/provenance"].(%{"sym" => "plan"})

    assert result["sym"] == "plan"
    assert result["introduced_at"]["id"] == n1.id
    assert Enum.map(result["rebound_at"], & &1["id"]) == [n2.id, n3.id]
  end

  test "a symbol introduced late has the right origin and no rebinds", %{
    verbs: verbs,
    nodes: [_n1, _n2, n3]
  } do
    result = verbs["hist/provenance"].(%{"sym" => "y"})
    assert result["introduced_at"]["id"] == n3.id
    assert result["rebound_at"] == []
  end

  test "a never-defined symbol has nil origin and empty rebinds", %{verbs: verbs} do
    result = verbs["hist/provenance"].(%{"sym" => "ghost"})
    assert result["introduced_at"] == nil
    assert result["rebound_at"] == []
  end

  test "PROOF: the PTC lens == the Elixir oracle (parity)", %{verbs: verbs} do
    for sym <- ["plan", "x", "y", "ghost"] do
      ptc = verbs["hist/provenance"].(%{"sym" => sym})
      elixir = verbs["hist/provenance!"].(%{"sym" => sym})
      assert ptc == elixir, "provenance lens/oracle disagree for #{sym}"
    end
  end

  test "PROPERTY: every name in the final env has EXACTLY one introducer", %{nodes: nodes} do
    final_names = ["plan", "x", "y"]

    for name <- final_names do
      introducers = Enum.filter(nodes, fn n -> name in n.introduced end)

      assert length(introducers) == 1,
             "#{name} should have exactly one introducer, got #{length(introducers)}"
    end
  end

  test "the projection exposes introduced + bound for lens authoring", %{} do
    [p1, p2, _p3] = Lens.project(@store, "prov")
    assert Enum.sort(p1["introduced"]) == ["plan", "x"]
    assert Enum.sort(p1["bound"]) == ["plan", "x"]
    # turn 2 bound plan (a rebind) but introduced nothing.
    assert p2["introduced"] == []
    assert p2["bound"] == ["plan"]
  end
end
