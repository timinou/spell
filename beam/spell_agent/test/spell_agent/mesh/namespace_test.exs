defmodule SpellAgent.Mesh.NamespaceTest do
  @moduledoc """
  Contracts for the black/* verbs (FEAT-010), driven directly through the verb map
  (the same closures Session.run merges). Pins: the monotone Fork-A core works
  single-node with NO consensus/watcher/spawn; claim arbitration is deterministic
  by store seq; re-goal is owner+liveness gated (P1.3); watch/decide are stubbed.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory
  alias SpellAgent.Mesh.Namespace
  alias SpellAgent.SessionRegistry

  setup do
    case Process.whereis(Memory),
      do: (
        nil -> start_supervised!(Memory)
        _ -> :ok
      )

    Store.clear(Memory)
    # SessionRegistry is app-supervised; ensure present for the live?/1 owner gate.
    case Process.whereis(SessionRegistry),
      do: (
        nil -> start_supervised!(SessionRegistry)
        _ -> :ok
      )

    :ok
  end

  defp verbs(session_id, region), do: Namespace.tools(Memory, session_id, region)
  defp call(session_id, region, verb, args), do: verbs(session_id, region)[verb].(args)

  describe "black/post" do
    test "posts a finding and returns its store seq as id" do
      r =
        call("sess-a", "reg1", "black/post", %{
          "kind" => "finding",
          "payload" => %{"about" => "caller"}
        })

      assert r["id"] == 1
      assert r["region"] == "reg1"
      assert r["kind"] == "finding"
    end

    test "rejects a claim kind (claims go through black/claim)" do
      r = call("s", "reg", "black/post", %{"kind" => "claim", "payload" => %{}})
      assert %{"err" => msg} = r
      assert msg =~ "black/claim"
    end

    test "rejects a write without capability for the region" do
      # tools/4 with held = [] denies the write
      v = Namespace.tools(Memory, "s", "reg", held: [])
      r = v["black/post"].(%{"kind" => "finding", "payload" => %{}})
      assert %{"err" => msg} = r
      assert msg =~ "capability"
    end
  end

  describe "black/query — content discovery" do
    test "filters by kind + where" do
      call("s", "reg", "black/post", %{
        "kind" => "finding",
        "payload" => %{"about" => "x", "risk" => "high"}
      })

      call("s", "reg", "black/post", %{
        "kind" => "finding",
        "payload" => %{"about" => "y", "risk" => "low"}
      })

      hits =
        call("s", "reg", "black/query", %{
          "match" => %{"kind" => "finding", "where" => %{"risk" => "high"}}
        })

      assert length(hits) == 1
      assert hd(hits)["payload"]["risk"] == "high"
    end
  end

  describe "black/claim — deterministic arbitration (P2.1/P2.3)" do
    test "two sessions claiming the same work: exactly one wins, both agree on owner" do
      r1 = call("sess-1", "reg", "black/claim", %{"work" => "W"})
      r2 = call("sess-2", "reg", "black/claim", %{"work" => "W"})

      # First claimant (lower seq) wins; both agree.
      assert r1["won?"] == true
      assert r2["won?"] == false
      assert r1["owner"] == r2["owner"]
      assert r1["owner"] == "sess-1"
      assert r1["provisional"] == true
    end

    test "an expired lease makes the work claimable by a later session" do
      # sess-1 claims with a 0ms lease (immediately expired on the next read)
      call("sess-1", "reg", "black/claim", %{"work" => "W", "lease_ms" => 1})
      Process.sleep(5)
      r2 = call("sess-2", "reg", "black/claim", %{"work" => "W"})
      # sess-1's claim is expired, so sess-2 wins
      assert r2["won?"] == true
      assert r2["owner"] == "sess-2"
    end
  end

  describe "black/fold — read-time reduce" do
    test "count and group-by over findings (the Fork-A synthesis)" do
      for {a, risk} <- [{"f1", "high"}, {"f2", "high"}, {"f3", "low"}] do
        call("s", "reg", "black/post", %{
          "kind" => "finding",
          "payload" => %{"about" => a, "risk" => risk}
        })
      end

      assert call("s", "reg", "black/fold", %{"over" => "finding", "reduce" => "count"}) == 3

      grouped =
        call("s", "reg", "black/fold", %{
          "over" => "finding",
          "reduce" => "group-by",
          "field" => "risk"
        })

      assert length(grouped["high"]) == 2
      assert length(grouped["low"]) == 1
    end
  end

  describe "Fork-A re-goal ownership (P1.3)" do
    test "the live owner may re-goal; a non-owner may not" do
      SessionRegistry.register("owner", %{prompt: "p", model: "m"})
      call("owner", "reg", "black/post", %{"kind" => "goal", "payload" => %{"objective" => "v1"}})

      # owner re-goals: ok
      ok =
        call("owner", "reg", "black/post", %{
          "kind" => "goal",
          "payload" => %{"objective" => "v2"}
        })

      assert ok["kind"] == "goal"

      # a different session re-goals: rejected
      bad =
        call("intruder", "reg", "black/post", %{
          "kind" => "goal",
          "payload" => %{"objective" => "v3"}
        })

      assert %{"err" => msg} = bad
      assert msg =~ "re-goaling rejected"
    end
  end

  describe "stubs" do
    test "decide is LIVE (FEAT-012) — validates + commits rather than stubbing" do
      # black/decide is no longer a stub: an empty call is rejected for a missing
      # :question (not a not-yet-wired message), and a well-formed call commits a
      # verdict. (Full consensus contracts live in consensus_test.exs.)
      assert %{"err" => d} = call("s", "reg", "black/decide", %{})
      assert d =~ "question"
      refute d =~ "FEAT-012"

      assert %{"verdict" => id} = call("s", "reg", "black/decide", %{"question" => "done?"})
      assert is_binary(id)
    end

    test "watch is LIVE (A3, FEAT-021) — validates rather than stubbing" do
      # black/watch is no longer a stub: an empty call is rejected for a missing
      # :when (not a not-yet-wired message), and a well-formed call registers.
      assert %{"err" => w} = call("s", "reg", "black/watch", %{})
      assert w =~ ":when"
      refute w =~ "FEAT-013"

      assert %{"id" => id} =
               call("s", "reg", "black/watch", %{
                 "when" => %{"kind" => "finding"},
                 "wake" => %{"prompt" => "go"}
               })

      assert is_integer(id)
    end
  end

  describe "the full Fork-A slice (no consensus/watcher/spawn)" do
    test "post goal + N findings, fold a ranked-by-risk result" do
      SessionRegistry.register("parent", %{prompt: "p", model: "m"})

      call("parent", "blast", "black/post", %{
        "kind" => "goal",
        "payload" => %{"objective" => "rank risk"}
      })

      for {f, risk} <- [{"a", "high"}, {"b", "low"}, {"c", "high"}] do
        call("child-#{f}", "blast", "black/post", %{
          "kind" => "finding",
          "payload" => %{"file" => f, "risk" => risk}
        })
      end

      grouped =
        call("parent", "blast", "black/fold", %{
          "over" => "finding",
          "reduce" => "group-by",
          "field" => "risk"
        })

      assert length(grouped["high"]) == 2
      assert length(grouped["low"]) == 1
      # the medium carried it all: 3 distinct authors, zero sibling messages.
    end
  end
end
