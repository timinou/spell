defmodule SpellAgent.Mesh.ConsensusTest do
  @moduledoc """
  Single-node contracts for black/decide (FEAT-012, PLAN-019 M2) against
  Store.Memory: decide seals at the store frontier, folds the sealed findings
  (default OR an agent-authored PTC :fold over data/findings), and writes ONE
  idempotent :verdict. A second decide at the same watermark is a no-op collapse
  onto the same id. A terminal verdict seals the region (no further posts).

  The two-node distribution gate (Ra election + partition {:pending}) is the
  multi-node path (FUP-020); this milestone ships + tests the single-node
  degeneration (PT-10).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Mesh.{Consensus, Namespace, Record, Store}

  setup do
    case Process.whereis(Memory) do
      nil -> start_supervised!(Memory)
      _ -> :ok
    end

    # A unique region per test so the shared Memory ETS table never bleeds across
    # tests (regions are keyed by id).
    region = "decide-#{System.unique_integer([:positive])}"
    %{region: region}
  end

  defp post_finding(region, payload, author \\ "s1") do
    {:ok, _} = Store.put(Memory, Record.new(:finding, region, payload, author: author))
  end

  describe "Consensus.decide (single-node)" do
    test "seals, folds (default), and writes exactly one verdict", %{region: region} do
      post_finding(region, %{"msg" => "a"})
      post_finding(region, %{"msg" => "b"})

      assert {:verdict, id, payload} =
               Consensus.decide(%{region: region, question: "done?", store: Memory})

      assert is_binary(id)
      assert payload["question"] == "done?"
      assert payload["findings_count"] == 2
      # Default fold returns the materialized findings + count.
      assert payload["result"]["count"] == 2

      # Exactly one verdict committed.
      assert length(Store.by_kind(Memory, region, :verdict)) == 1
    end

    test "a re-decide at the same watermark is idempotent (same id, no second verdict)",
         %{region: region} do
      post_finding(region, %{"msg" => "a"})

      assert {:verdict, id1, _} =
               Consensus.decide(%{region: region, question: "q", store: Memory})

      assert {:verdict, id2, _} =
               Consensus.decide(%{region: region, question: "q", store: Memory})

      assert id1 == id2
      # No second verdict record — the re-decide collapsed onto the existing id.
      assert length(Store.by_kind(Memory, region, :verdict)) == 1
    end

    test "a new finding after a decide moves the watermark -> a NEW verdict id",
         %{region: region} do
      post_finding(region, %{"msg" => "a"})
      assert {:verdict, id1, _} = Consensus.decide(%{region: region, question: "q", store: Memory})

      post_finding(region, %{"msg" => "b"})
      assert {:verdict, id2, _} = Consensus.decide(%{region: region, question: "q", store: Memory})

      # Different watermark -> different id -> a second, distinct verdict.
      refute id1 == id2
    end

    test "an agent-authored PTC :fold runs over data/findings (userland boundary)",
         %{region: region} do
      post_finding(region, %{"score" => 3})
      post_finding(region, %{"score" => 4})

      # The fold sums the findings' score payloads — pure PTC over the materialized
      # projection (string-keyed maps), exactly the Hist.Lens pattern.
      fold = ~s|(reduce (fn [acc f] (+ acc (get (get f "payload") "score"))) 0 data/findings)|

      assert {:verdict, _id, payload} =
               Consensus.decide(%{region: region, question: "sum", fold: fold, store: Memory})

      assert payload["result"] == 7
    end

    test "a bad :fold yields a fold error, never a corrupt commit", %{region: region} do
      post_finding(region, %{"msg" => "a"})

      # references an undefined var -> the sandbox fails -> {:error, {:fold_failed, _}}
      bad_fold = ~s|(this-is-not-defined data/findings)|

      assert {:error, {:fold_failed, _}} =
               Consensus.decide(%{region: region, question: "q", fold: bad_fold, store: Memory})

      # No verdict was written (the bad fold did not commit).
      assert Store.by_kind(Memory, region, :verdict) == []
    end

    test "a terminal verdict seals the region; further posts are rejected",
         %{region: region} do
      post_finding(region, %{"msg" => "a"})

      assert {:verdict, _id, _} =
               Consensus.decide(%{region: region, question: "final", terminal: true, store: Memory})

      assert Store.sealed?(Memory, region)
      # A post to a sealed region is rejected.
      assert {:error, :sealed} = Store.put(Memory, Record.new(:finding, region, %{"x" => 1}))
    end

    test "missing region/question/store is a clear error, never a crash", %{region: region} do
      assert {:error, {:invalid, :question, _}} =
               Consensus.decide(%{region: region, store: Memory})

      assert {:error, {:invalid, :region, _}} =
               Consensus.decide(%{question: "q", store: Memory})

      assert {:error, {:invalid, :store, _}} =
               Consensus.decide(%{region: region, question: "q"})
    end
  end

  describe "black/decide verb (the PTC surface)" do
    test "decide via the namespace verb returns a verdict map", %{region: region} do
      post_finding(region, %{"msg" => "a"})
      tools = Namespace.tools(Memory, "s1", region, held: [region])
      decide = tools["black/decide"]

      result = decide.(%{"question" => "ship?"})

      assert %{"verdict" => id, "region" => ^region, "payload" => payload} = result
      assert is_binary(id)
      assert payload["question"] == "ship?"
    end

    test "decide without a write capability is rejected", %{region: region} do
      tools = Namespace.tools(Memory, "s1", region, held: ["some-other-region"])
      decide = tools["black/decide"]

      assert %{"err" => err} = decide.(%{"question" => "q"})
      assert err =~ "no write capability"
    end

    test "decide without a question is rejected", %{region: region} do
      tools = Namespace.tools(Memory, "s1", region, held: [region])
      decide = tools["black/decide"]

      assert %{"err" => err} = decide.(%{})
      assert err =~ "question"
    end

    test "a terminal decide via the verb seals the region", %{region: region} do
      post_finding(region, %{"msg" => "a"})
      tools = Namespace.tools(Memory, "s1", region, held: [region])

      assert %{"verdict" => _} = tools["black/decide"].(%{"question" => "q", "terminal" => true})
      assert Store.sealed?(Memory, region)
    end
  end

  describe "project_findings (the materialize boundary)" do
    test "projects only findings <= watermark, string-keyed, no structs", %{region: region} do
      post_finding(region, %{"msg" => "a"})
      post_finding(region, %{"msg" => "b"})
      watermark = Store.max_seq(Memory, region)
      post_finding(region, %{"msg" => "c-after"})

      projected = Consensus.project_findings(Memory, region, watermark)

      assert length(projected) == 2
      # Every value is a plain string-keyed map (no %Record{} struct crosses).
      assert Enum.all?(projected, fn p -> is_map(p) and not is_struct(p) end)
      assert Enum.all?(projected, fn p -> Map.has_key?(p, "payload") and Map.has_key?(p, "seq") end)
    end
  end
end
