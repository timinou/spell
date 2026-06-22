defmodule SpellAgent.ShDemosTest do
  @moduledoc """
  The sh+brush vision as executable demos (PLAN-011 W6).

  Each test is a demo from the plan, doubling as an integration test: it proves
  one of the three promises — WRITE (sh::), COMPOSE (Lisp over shell output),
  REMEMBER (durable :ptc tools) — plus the homoiconic PARSE layer, end to end
  through the real PTC evaluator. A fixture tree gives rg/wc something to chew.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Memory

  setup_all do
    dir = Path.join(System.tmp_dir!(), "sh_demos_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(dir, "lib"))
    File.write!(Path.join(dir, "lib/a.ex"), "# TODO: alpha\ndef a, do: 1\n")
    File.write!(Path.join(dir, "lib/b.ex"), "def b, do: 2\n# TODO: beta\n")
    File.write!(Path.join(dir, "lib/c.ex"), "def c, do: 3\n")
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, dir: dir}
  end

  setup do
    case SpellAgent.ToolRegistry.start_link([]) do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> :ok
    end

    Store.clear(Memory)
    # Isolate: the registry is a named singleton; drop any tool a prior test
    # defined so durable state cannot leak between demos (same pattern as
    # tools_test.exs). Without this, demo 4/5's "todo-files" persists.
    for e <- SpellAgent.ToolRegistry.all(), do: SpellAgent.ToolRegistry.remove(e.name)
    :ok
  end

  defp run!(src, ctx \\ %{}) do
    tools = SpellAgent.Tools.build_tools_map()

    {:ok, step} =
      PtcRunner.Lisp.run(src,
        tools: tools,
        caller: :in_process_v1,
        context: ctx,
        timeout_ms: 10_000
      )

    step.return
  end

  # ── Demo 1: WRITE — almost-native shell at the leaf ──────────────────────
  test "demo 1: write a one-liner with sh::", %{dir: dir} do
    out = run!(~S|(:lines (sh:: rg -l TODO ~data/lib))|, %{"lib" => Path.join(dir, "lib")})
    # rg returns matching files; a.ex and b.ex have TODO, c.ex does not.
    assert length(out) == 2
    assert Enum.all?(out, &String.ends_with?(&1, ".ex"))
  end

  # ── Demo 2: COMPOSE (value pipe) — Lisp is the composition layer ─────────
  test "demo 2: compose with ->> + pmap over :lines", %{dir: dir} do
    src = ~S|(->> (sh:: rg -l TODO ~data/lib) :lines (map (fn [f] (:out (sh:: wc -l ~f)))) count)|
    assert run!(src, %{"lib" => Path.join(dir, "lib")}) == 2
  end

  # ── Demo 3: COMPOSE (byte pipe) — brush connects stdout->stdin ───────────
  test "demo 3: byte pipeline via tool/sh-pipe", %{dir: dir} do
    f = Path.join(dir, "lib/a.ex")
    src = ~s|(:out (tool/sh-pipe {:stages [["cat" "#{f}"] ["wc" "-l"]]}))|
    assert String.trim(run!(src)) == "2"
  end

  # ── Demo 4: REMEMBER — a sh:: script becomes a durable :ptc tool ─────────
  test "demo 4: define a durable tool wrapping sh::, survives in the store" do
    run!(~S|(tool/define-tool {:name "todo-files" :params [:dir] :scope "durable"
                               :source "(:lines (sh:: rg -l TODO ~data/dir))"})|)

    # The durable tool was mirrored to the history store (the toolset).
    assert {:ok, %SpellAgent.Hist.ToolDef{source: src, scope: :durable}} =
             Store.fetch(Memory, {:tool, "todo-files"})

    assert src =~ "sh::"
  end

  # ── Demo 5: COMPOSE remembered tools in pure Lisp ────────────────────────
  test "demo 5: compose a remembered tool with Lisp combinators", %{dir: dir} do
    run!(~S|(tool/define-tool {:name "todo-files" :params [:dir]
                               :source "(:lines (sh:: rg -l TODO ~data/dir))"})|)

    src =
      ~s|(->> (tool/todo-files {:dir "#{Path.join(dir, "lib")}"}) (map clojure.string/upper-case) count)|

    assert run!(src) == 2
  end

  # ── Demo 6: INJECTION-SAFE — a metacharacter value stays literal ─────────
  test "demo 6: injection via ~unquote is neutralized (sentinel survives)", %{dir: dir} do
    # The payload tries to delete a sentinel via command substitution + rm. If
    # any of it executed, the sentinel would vanish; inject-proofness keeps the
    # whole string a single literal echo argument.
    sentinel = Path.join(dir, "sentinel_#{System.unique_integer([:positive])}")
    File.write!(sentinel, "alive")
    payload = "; rm -f #{sentinel}; $(rm -f #{sentinel})"

    out = run!(~S|(:out (sh:: echo ~data/x))|, %{"x" => payload})

    assert String.trim(out) == payload, "payload was altered — something expanded it"
    assert File.exists?(sentinel), "sentinel deleted — the payload EXECUTED (injection!)"
    assert File.read!(sentinel) == "alive"
  end

  # ── Demo 7: URI tokens (skill:// local:// …) — DEFERRED, intentionally absent.
  # The WordPreprocessor/SchemeRegistry that resolves URI tokens inside argv runs
  # on the NAPI/TS brush path but is NOT wired into the BEAM brush NIF yet (it
  # needs the kernel SchemeRegistry constructed BEAM-side or bridged via a host
  # callback — risk R4 in PLAN-011). Asserting it here would be a fake-green test,
  # so demo 7 is deliberately omitted until that wiring lands in a focused wave.

  # ── Demo 8: HOMOICONIC — parse bash to a tree, mutate, unparse, run ──────
  test "demo 8: parse -> tree -> unparse round-trips AND runs" do
    tree = run!(~S|(tool/sh-parse {:src "echo hello world"})|)
    assert %{"node" => "program", "children" => [cmd]} = tree
    assert %{"node" => "command", "name" => "echo"} = cmd

    # Unparse back to bash, then RUN it through sh -c and assert the SAME output
    # the original command would produce — a real round-trip, not a substring.
    bash = run!(~S|(:bash (tool/sh-unparse {:tree (tool/sh-parse {:src "echo hello world"})}))|)
    out = run!(~s|(:out (tool/sh {:argv ["sh" "-c" "#{bash}"]}))|)
    assert String.trim(out) == "hello world"
  end

  # ── Demo 9: RECALL — find turns by shell command head ────────────────────
  test "demo 9: hist/forms {:shell ...} recalls shell turns" do
    alias SpellAgent.Hist.{Query, Recorder}
    {:ok, ast} = PtcRunner.Lisp.Parser.parse(~S|(tool/sh {:argv ["rg" "TODO"]})|)
    {:ok, core} = PtcRunner.Lisp.Analyze.analyze(ast)
    Recorder.record_node(Memory, "s", %{program: core, memory: %{}, tool_calls: []}, nil)

    assert [_] = Query.forms(Memory, "s", {:shell, "rg"})
    assert [] = Query.forms(Memory, "s", {:shell, "grep"})
  end

  # ── Demo 10: MODULARITY — same (tool/sh) data from sugar OR hand-written ─
  test "demo 10: sh:: sugar and hand-written tool/sh produce the same result" do
    sugar = run!(~S|(:out (sh:: echo modular))|)
    hand = run!(~S|(:out (tool/sh {:argv ["echo" "modular"]}))|)
    assert sugar == hand
    assert String.trim(sugar) == "modular"
  end
end
