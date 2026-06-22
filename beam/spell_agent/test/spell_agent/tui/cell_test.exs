defmodule SpellAgent.Tui.CellTest do
  @moduledoc """
  W0 contract (PROJ-004): the reactive-cell resolver — the off-frame, read-only
  sibling of `HoleResolver`.

  `Cell.resolve/3` thaws a frozen `quote`d query and evaluates it through the same
  sandboxed `PtcRunner.Lisp.run/2` a render hole uses, with `data/*` bound and a
  caller-supplied READ-ONLY tools map. Pins: value resolution against `data/*`,
  the read-only tool GRANT (a cell CAN call a granted query tool — the whole point
  of the layer), the no-tools default is inert (a cell with no tier is as pure as
  a render hole), and the failure ladder (never raises; any failure -> :error).

  The frozen query is produced by the real `quote` reader (PLAN-012 W0/W1), whose
  return IS the persisted codec shape (`%{"node" => …}`), so these tests exercise
  the genuine producer -> persist -> resolve path, not a hand-built fixture.
  """
  use ExUnit.Case, async: true

  alias PtcRunner.Lisp
  alias SpellAgent.Tui.Cell

  # The canonical frozen-query shape: `quote` returns codec data directly (W0).
  # This is exactly what `cell/define` will persist as the query (W2).
  defp frozen(src) do
    {:ok, step} = Lisp.run("(quote #{src})")
    step.return
  end

  defp resolve(src, env, tools \\ %{}), do: Cell.resolve(frozen(src), env, tools)

  # ============================================================
  # value resolution against data/*
  # ============================================================

  describe "a cell resolves a pure query against data/*" do
    test "reads a nested data value (no tools needed)" do
      assert {:ok, "opus"} =
               resolve(~S|(get data/status :model)|, %{"status" => %{"model" => "opus"}})
    end

    test "computes from data" do
      assert {:ok, 42} = resolve(~S|(* 2 (get data/x :v))|, %{"x" => %{"v" => 21}})
    end

    test "a missing data key resolves to nil, not a crash" do
      assert {:ok, nil} = resolve(~S|(get data/nope :k)|, %{})
    end
  end

  # ============================================================
  # the read-only tool grant — the heart of PROJ-004
  # ============================================================

  describe "a cell CAN call a granted read-only query tool" do
    test "a cursor-keyed query reaches a granted tool and threads data/*" do
      # The acceptance mechanic in miniature: a query that reads the cursor from
      # data/ui and calls a granted `tool/find`. The tool is registered under its
      # BARE name ("find") — `(tool/find …)` resolves by stripping the `tool/`
      # namespace (matches how SpellAgent.Tools registers the real surface).
      tools = %{"find" => fn args -> %{"target" => Map.get(args, "target")} end}

      assert {:ok, %{"target" => "S42 def->"}} =
               resolve(
                 ~S|(tool/find {:target (str (get data/ui :cursor-id) " def->")})|,
                 %{"ui" => %{"cursor-id" => "S42"}},
                 tools
               )
    end

    test "the granted tool actually runs (effect observed via its return)" do
      parent = self()

      tools = %{
        "find" => fn args ->
          send(parent, {:tool_ran, Map.get(args, "target")})
          ["a", "b"]
        end
      }

      assert {:ok, ["a", "b"]} =
               resolve(~S|(tool/find {:target "x"})|, %{}, tools)

      assert_received {:tool_ran, "x"}
    end
  end

  # ============================================================
  # capability boundary — the default tier is INERT
  # ============================================================

  describe "the no-tools default is as inert as a render hole" do
    test "a cell with no granted tier cannot call any tool/" do
      # No tools map -> the query's `tool/find` is an unknown tool -> :error.
      # A cell never acquires a capability it was not explicitly granted.
      assert :error = resolve(~S|(tool/find {:target "x"})|, %{"ui" => %{}})
    end

    test "an explicitly empty tools map is equally inert" do
      assert :error = resolve(~S|(tool/edit {:target "x"})|, %{}, %{})
    end
  end

  # ============================================================
  # failure ladder — never raises, any failure collapses to :error
  # ============================================================

  describe "the failure ladder never bricks the bag" do
    test "malformed frozen data resolves to :error, not a raise" do
      assert :error = Cell.resolve(%{"node" => "bogus"}, %{})
    end

    test "a query that raises inside a granted tool degrades to :error" do
      tools = %{"find" => fn _args -> raise "boom" end}
      assert :error = resolve(~S|(tool/find {:target "x"})|, %{}, tools)
    end

    test "a non-codec frozen term resolves to :error" do
      assert :error = Cell.resolve("not codec data", %{})
    end
  end

  # ============================================================
  # author-shape robustness — bare form vs hole/splice wrapper
  # ============================================================

  describe "both author shapes of a frozen query resolve identically" do
    test "a query wrapped as a __hole__ leaf unwraps and resolves" do
      inner = frozen(~S|(get data/x :v)|)
      assert {:ok, 7} = Cell.resolve(%{"__hole__" => inner}, %{"x" => %{"v" => 7}})
    end

    test "a query wrapped as a __splice__ leaf unwraps and resolves" do
      inner = frozen(~S|(get data/x :v)|)
      assert {:ok, [1, 2]} = Cell.resolve(%{"__splice__" => inner}, %{"x" => %{"v" => [1, 2]}})
    end
  end
end
