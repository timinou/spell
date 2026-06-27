defmodule SpellAgent.Mesh.BudgetTest do
  @moduledoc """
  Contracts for the M0 enabler (PLAN-019): the mesh config cells and the
  app-supervised `Mesh.Budget` ParallelBudget holder.

  `Mesh.Budget` is an app-supervised named singleton (capacity from the
  `"mesh.budget"` config default), so these tests exercise the LIVE instance
  rather than starting their own — and pair every acquire with a release so the
  shared slot counter returns to baseline (the no-leak contract is the point).

  Pins: the three mesh cells are whitelisted + carry defaults (define-config can
  set them; a typo'd mesh key is still rejected); the holder hands out ONE shared
  budget struct; the live capacity reflects the config default (the config→holder
  wiring); acquire/release does not leak a slot; and capacity is enforced
  (`:full` past the ceiling).
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp.Eval.ParallelBudget
  alias SpellAgent.Config
  alias SpellAgent.Mesh.Budget

  describe "config mesh cells (M0)" do
    setup do
      # Config is app-supervised; restore the mesh cells after each test so a
      # mutation here can't leak into another test in the (global) Config.
      saved = Map.take(Config.all(), ~w(mesh.budget mesh.lease_ms mesh.default_store))

      on_exit(fn ->
        Enum.each(saved, fn {k, v} -> Config.put(k, v) end)
      end)

      :ok
    end

    test "the three mesh cells are whitelisted and settable via put/2" do
      assert :ok = Config.put("mesh.budget", 16)
      assert :ok = Config.put("mesh.lease_ms", 5_000)
      assert :ok = Config.put("mesh.default_store", "khepri")

      assert Config.get("mesh.budget") == 16
      assert Config.get("mesh.lease_ms") == 5_000
      assert Config.get("mesh.default_store") == "khepri"
    end

    test "the mesh budget cell is a positive integer out of the box" do
      assert is_integer(Config.get("mesh.budget"))
      assert Config.get("mesh.budget") > 0
    end

    test "an unknown mesh key is still rejected (no silent typo)" do
      assert {:error, reason} = Config.put("mesh.budgett", 4)
      assert reason =~ "unknown config key"
    end
  end

  describe "Budget holder (live app-supervised singleton)" do
    setup do
      assert pid = Process.whereis(Budget), "Mesh.Budget must be app-supervised"
      assert is_pid(pid)

      # Drain any slot a failed assertion may leave held, so a leak in one test
      # cannot cascade into the next (the budget is a global singleton).
      on_exit(&drain/0)
      :ok
    end

    test "fetch hands out THE shared budget struct (same atomics ref), held 0 at rest" do
      assert {:ok, %ParallelBudget{} = b1} = Budget.fetch()
      assert {:ok, %ParallelBudget{} = b2} = Budget.fetch()
      assert b1.atomics_ref == b2.atomics_ref
      assert Budget.held() == 0
    end

    test "the live capacity reflects the config default (config -> holder wiring)" do
      assert Budget.capacity() == Config.get("mesh.budget")
      assert Budget.capacity() > 0
      assert Budget.available() == Budget.capacity()
    end

    test "acquire then release returns held to baseline (no slot leak)" do
      assert Budget.held() == 0
      assert {:ok, budget} = Budget.try_acquire()
      assert Budget.held() == 1
      assert :ok = Budget.release(budget)
      assert Budget.held() == 0
    end

    test "acquiring past capacity returns :full; releasing frees a slot again" do
      cap = Budget.capacity()
      assert Budget.held() == 0

      held =
        for _ <- 1..cap do
          assert {:ok, b} = Budget.try_acquire()
          b
        end

      assert Budget.available() == 0
      assert Budget.held() == cap

      # One more over the ceiling hands its slot back -> :full, held unchanged.
      assert :full = Budget.try_acquire()
      assert Budget.held() == cap

      [first | rest] = held
      assert :ok = Budget.release(first)
      assert Budget.available() == 1
      assert {:ok, again} = Budget.try_acquire()
      assert Budget.held() == cap

      Enum.each([again | rest], fn b -> assert :ok = Budget.release(b) end)
      assert Budget.held() == 0
    end

    test "release is underflow-safe: releasing a never-held slot degrades to :ok" do
      # The strict ParallelBudget contract raises on underflow; the Mesh.Budget
      # wrapper rescues it so a double-release / release-after-crash never bricks.
      assert {:ok, budget} = Budget.fetch()
      assert Budget.held() == 0
      assert :ok = Budget.release(budget)
      assert Budget.held() == 0
    end
  end

  describe "best-effort when the holder is absent" do
    setup do
      # Terminate the app-supervised singleton for the duration of this test,
      # restoring it afterwards so the rest of the suite sees a live holder.
      sup = SpellAgent.Supervisor
      :ok = Supervisor.terminate_child(sup, SpellAgent.Mesh.Budget)
      on_exit(fn -> Supervisor.restart_child(sup, SpellAgent.Mesh.Budget) end)
      :ok
    end

    test "wrappers degrade rather than crashing when the holder is down" do
      refute Process.whereis(Budget)
      assert :error = Budget.fetch()
      assert :no_budget = Budget.try_acquire()
      assert Budget.held() == 0
      assert Budget.available() == 0
      assert Budget.capacity() == 0
    end
  end

  # Release held slots until the shared counter is back to zero.
  defp drain do
    case Budget.fetch() do
      {:ok, budget} -> drain(budget)
      :error -> :ok
    end
  end

  defp drain(budget) do
    if Budget.held() > 0 do
      Budget.release(budget)
      drain(budget)
    end
  end
end
