defmodule SpellAgent.Tui.DataSourceVerbTest do
  @moduledoc """
  PLAN-027 M1 (FUP-036): the `data-source/*` verb surface + the read-only source
  tier. Defends the contract that the mind can register its OWN query-clock data
  sources as frozen PTC programs, that the producer runs in a bounded read-only
  sandbox (a mutator is unreachable), and the register/list/remove lifecycle.
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp
  alias SpellAgent.Tui.DataSource.{Registry, Verb, Tools}

  setup do
    case Process.whereis(Registry) do
      nil -> start_supervised!({Registry, []})
      _ -> :ok
    end

    Registry.reset()
    on_exit(fn -> if Process.whereis(Registry), do: Registry.reset() end)
    :ok
  end

  defp run(src), do: Lisp.run(src, tools: Verb.tools(), caller: :in_process_v1)

  describe "data-source/register" do
    test "registers a frozen program and it resolves on the query clock" do
      {:ok, step} =
        run(~s|(data-source/register {:name "live" :program (quote (tool/session-registry/lineage))})|)

      assert step.return == %{"ok" => true, "name" => "live"}
      assert "live" in Registry.names()

      # Resolves through the frozen program (no live sessions -> []).
      assert Registry.resolve_all(%{hist_store: nil}) == %{"live" => []}
    end

    test "the registered producer is a FROZEN program, not an Elixir closure" do
      {:ok, _} = run(~s|(data-source/register {:name "s" :program (quote (tool/session-registry/lineage))})|)
      assert match?({:frozen, _}, Registry.all()["s"])
    end

    test "rejects a non-quoted :program (must be codec data)" do
      {:ok, step} = run(~s|(data-source/register {:name "bad" :program 42})|)
      assert %{"err" => msg} = step.return
      assert msg =~ "quote"
      refute "bad" in Registry.names()
    end

    test "rejects a missing :name" do
      {:ok, step} = run(~s|(data-source/register {:program (quote 1)})|)
      assert %{"err" => _} = step.return
    end
  end

  describe "data-source/list + remove" do
    test "list reflects registered sources; remove unregisters" do
      {:ok, _} = run(~s|(data-source/register {:name "a" :program (quote (tool/session-registry/lineage))})|)
      {:ok, _} = run(~s|(data-source/register {:name "b" :program (quote (tool/session-registry/lineage))})|)

      {:ok, listed} = run(~s|(data-source/list {})|)
      names = Enum.map(listed.return, &Map.get(&1, "name")) |> Enum.sort()
      assert names == ["a", "b"]

      {:ok, _} = run(~s|(data-source/remove {:name "a"})|)
      refute "a" in Registry.names()
      assert "b" in Registry.names()
    end
  end

  describe "sandbox — a producer runs read-only (looking never acts)" do
    test "a mutator verb is UNREACHABLE from a producer program" do
      # A producer that TRIES to mutate the keymap registry: keymap/bind is not
      # in the read-only tier, so the call is an unknown tool -> the whole
      # program degrades to :error -> the source is omitted, NEVER executed.
      {:ok, _} =
        run(~s|(data-source/register {:name "evil" :program (quote (keymap/bind {:context "x" :chord "y" :intent "z"}))})|)

      # The evil source resolves to nothing (omitted), never mutating anything.
      resolved = Registry.resolve_all(%{hist_store: nil})
      refute Map.has_key?(resolved, "evil")
    end

    test "the read-only tier admits ONLY the vetted source verbs" do
      # The tier a producer runs in exposes exactly the two source primitives.
      tier = Tools.read_only(%{hist_store: nil})
      assert Map.keys(tier) |> Enum.sort() == ["hist/trace-summary", "session-registry/lineage"]
      # And every admitted verb is on the allowlist; no forbidden verb is.
      assert Tools.allowed?("session-registry/lineage")
      assert Tools.allowed?("hist/trace-summary")
      refute Tools.allowed?("keymap/bind")
      refute Tools.allowed?("layout/set")
    end

    test "source verbs and forbidden verbs are disjoint (defense-in-depth invariant)" do
      assert MapSet.disjoint?(Tools.source_verbs(), Tools.forbidden_verbs())
    end
  end
end
