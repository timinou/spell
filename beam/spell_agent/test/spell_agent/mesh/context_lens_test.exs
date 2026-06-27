defmodule SpellAgent.Mesh.ContextLensTest do
  @moduledoc """
  Contracts for the context lens (FEAT-017, PLAN-019 M7): a child's context as a
  projection over the region blackboard + sibling reasoning at a spawn watermark.

  Pins: the watermark boundary (records > W excluded); the WHAT+WHY join (a
  finding carries its author's reasoning when the hist node exists, the finding
  alone when it doesn't); determinism at equal W (two children get an identical
  baseline); the scope predicate narrows the projection; the source folds
  (findings/edited_files) over append-only stores.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Mesh.{ContextLens, Namespace, Record}
  alias SpellAgent.Mesh.Store, as: MeshStore

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    Store.clear(Memory)
    region = "ctx-#{System.unique_integer([:positive])}"
    %{region: region}
  end

  defp post_finding(region, payload, author) do
    {:ok, rec} = MeshStore.put(Memory, Record.new(:finding, region, payload, author: author))
    rec
  end

  defp handle(region, watermark, session \\ "child-1") do
    %{"region" => region, "session" => session, "watermark" => watermark}
  end

  describe "watermark boundary" do
    test "records <= W are included, > W excluded", %{region: region} do
      post_finding(region, %{"n" => 1}, "s1")
      post_finding(region, %{"n" => 2}, "s2")
      w = MeshStore.max_seq(Memory, region)
      post_finding(region, %{"n" => 3}, "s3")

      bag = ContextLens.build_context(handle(region, w), store: Memory, join_hist: false)

      ns = Enum.map(bag["findings"], fn f -> f["payload"]["n"] end) |> Enum.sort()
      assert ns == [1, 2]
      refute 3 in ns
    end
  end

  describe "WHAT+WHY join" do
    test "a finding carries its author's reasoning when the hist exists", %{region: region} do
      # Seed a hist node for session "author-s" so the join finds reasoning. (A
      # minimal node: the projection reads tool_calls/form_src.)
      seed_hist_node("author-s")
      post_finding(region, %{"risk" => "high"}, "author-s")
      w = MeshStore.max_seq(Memory, region)

      bag = ContextLens.build_context(handle(region, w), store: Memory, join_hist: true)

      [entry] = bag["findings"]
      assert entry["author"] == "author-s"
      assert is_list(entry["reasoning"])
      # The reasoning carries the author's projected hist node(s).
      assert length(entry["reasoning"]) >= 1
    end

    test "a finding whose author hist is absent degrades to the finding alone (WHAT only)",
         %{region: region} do
      post_finding(region, %{"risk" => "low"}, "ghost-author")
      w = MeshStore.max_seq(Memory, region)

      bag = ContextLens.build_context(handle(region, w), store: Memory, join_hist: true)

      [entry] = bag["findings"]
      # The finding is present; reasoning is empty (the author's hist is absent),
      # never a failure.
      assert entry["author"] == "ghost-author"
      assert entry["reasoning"] == []
    end
  end

  describe "determinism (the cohort baseline)" do
    test "two contexts at the same W are identical", %{region: region} do
      post_finding(region, %{"n" => 1}, "s1")
      post_finding(region, %{"n" => 2}, "s2")
      w = MeshStore.max_seq(Memory, region)

      bag1 = ContextLens.build_context(handle(region, w, "c1"), store: Memory, join_hist: false)
      bag2 = ContextLens.build_context(handle(region, w, "c2"), store: Memory, join_hist: false)

      # The findings/goals/verdicts baseline is identical at equal W (the
      # per-child session id differs but does not affect the projected cohort).
      assert bag1["findings"] == bag2["findings"]
      assert bag1["goals"] == bag2["goals"]
      assert bag1["watermark"] == bag2["watermark"]
    end
  end

  describe "scope predicate" do
    test ":where narrows the findings projection", %{region: region} do
      post_finding(region, %{"risk" => "high", "id" => 1}, "s1")
      post_finding(region, %{"risk" => "low", "id" => 2}, "s2")
      post_finding(region, %{"risk" => "high", "id" => 3}, "s3")
      w = MeshStore.max_seq(Memory, region)

      bag =
        ContextLens.build_context(handle(region, w),
          store: Memory,
          join_hist: false,
          where: %{"risk" => "high"}
        )

      ids = Enum.map(bag["findings"], fn f -> f["payload"]["id"] end) |> Enum.sort()
      assert ids == [1, 3]
    end
  end

  describe "source folds" do
    test "findings/4 projects findings at <= W with an optional predicate", %{region: region} do
      post_finding(region, %{"risk" => "high"}, "s1")
      post_finding(region, %{"risk" => "low"}, "s2")
      w = MeshStore.max_seq(Memory, region)

      all = ContextLens.findings(Memory, region, w)
      high = ContextLens.findings(Memory, region, w, %{"risk" => "high"})

      assert length(all) == 2
      assert length(high) == 1
    end
  end

  describe "black/context verb" do
    test "the verb returns a context bag at the live frontier", %{region: region} do
      post_finding(region, %{"n" => 1}, "s1")
      tools = Namespace.tools(Memory, "me", region, held: [region])

      bag = tools["black/context"].(%{})

      assert %{"region" => ^region, "findings" => findings} = bag
      assert length(findings) == 1
    end

    test "the verb honors a :where scope predicate", %{region: region} do
      post_finding(region, %{"risk" => "high"}, "s1")
      post_finding(region, %{"risk" => "low"}, "s2")
      tools = Namespace.tools(Memory, "me", region, held: [region])

      bag = tools["black/context"].(%{"where" => %{"risk" => "high"}})
      assert length(bag["findings"]) == 1
    end
  end

  # Seed a minimal hist node for a session so Hist.Lens.project returns reasoning.
  # Uses the same store the lens reads.
  defp seed_hist_node(session_id) do
    node = %SpellAgent.Hist.Node{
      id: "node-#{System.unique_integer([:positive])}",
      session: session_id,
      seq: 0,
      status: :ok,
      form_src: "(black/post {:kind :finding})",
      sees: [],
      binds: %{},
      introduced: [],
      tokens: %{input: 0, output: 0}
    }

    Store.put(Memory, {:node, session_id, node.id}, node)
  end
end
