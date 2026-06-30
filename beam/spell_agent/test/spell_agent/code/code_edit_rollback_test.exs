defmodule SpellAgent.Code.CodeEditRollbackTest do
  @moduledoc """
  FUP-027 end-to-end: a `code-edit` write participates in all-or-nothing rollback
  when the enclosing PTC program fails.

  This exercises the WHOLE seam in one run, in the real sandbox worker:
    * `code-edit` (via gate_write) snapshots the target's prior state into the
      worker-side `Code.Journal`;
    * the runner's `on_complete: &Code.Journal.finalize/1` drains the journal
      in-worker by the program's verdict — `:ok` keeps the write, a `(fail …)`
      restores the file.

  The headline acceptance: `(do (code-edit …) (fail …))` leaves the target at its
  PRE-edit bytes; a successful program keeps the write; multiple edits are
  all-or-nothing.
  """
  use ExUnit.Case, async: false

  alias PtcRunner.Lisp.Prelude.Compiler
  alias SpellAgent.Code
  alias SpellAgent.Code.Journal

  @q_source File.read!(
              Path.join([:code.priv_dir(:spell_agent) |> to_string(), "preludes", "q.clj"])
            )

  setup_all do
    {:ok, prelude} = Compiler.compile(@q_source)
    {:ok, prelude: prelude}
  end

  setup do
    # The journal is process-dict scoped and these tests run sync in one process;
    # the "no finalizer" case deliberately leaves entries undrained, so clear any
    # leftover stack before each test to keep them isolated (drain == drop on :ok).
    Journal.finalize(:ok)
    dir = Path.join(System.tmp_dir!(), "code_rollback_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, dir: dir}
  end

  # Run a program with the code-* tools exposed and the FUP-027 finalizer wired,
  # exactly as Session.run wires it onto the agent. Returns the run result tuple.
  defp run(prelude, program, binds) do
    PtcRunner.Lisp.run(program,
      prelude: prelude,
      context: binds,
      tools: %{
        "code-edit" => &Code.edit_tool/1,
        "code-apply" => &Code.apply_tool/1
      },
      on_complete: &Journal.finalize/1,
      filter_context: false,
      caller: :in_process_v1
    )
  end

  # A program-level `(fail msg)` surfaces from Lisp.run as `{:ok, step}` with
  # `step.return == {:__ptc_fail__, msg}` (a SUCCESSFUL run carrying a failure
  # signal), NOT `{:error, _}` (which is a runtime/compile error). The journal
  # finalizer classifies BOTH as a failed verdict; this asserts the (fail) shape.
  defp assert_failed(result) do
    assert {:ok, step} = result
    assert match?({:__ptc_fail__, _}, step.return)
  end

  # The rename-x->y edit as a reifiable op-list applied via code-apply (one call:
  # read+parse+edit+write), so the program is a single code-edit + a verdict.
  defp rename_program(_path) do
    """
    (tool/code-apply
      {:path data/path :lang "elixir"
       :ops [{"op" "update"
              "pattern" {"node" "identifier" "value" "x"}
              "template" {"node" "identifier" "value" "y"}}]})
    """
  end

  describe "rollback on program failure" do
    test "a code-edit followed by (fail) restores the file to its pre-edit bytes",
         %{prelude: prelude, dir: dir} do
      path = Path.join(dir, "a.ex")
      File.write!(path, "x + 1")

      program = "(do #{rename_program(path)} (fail \"boom\"))"

      assert_failed(run(prelude, program, %{"path" => path}))
      # the edit was rolled back: the file is back to its original content.
      assert File.read!(path) == "x + 1"
    end

    test "a successful program KEEPS the code-edit write", %{prelude: prelude, dir: dir} do
      path = Path.join(dir, "b.ex")
      File.write!(path, "x + 1")

      program = "(do #{rename_program(path)} (return \"ok\"))"

      assert {:ok, step} = run(prelude, program, %{"path" => path})
      assert step.return == {:__ptc_return__, "ok"}
      # the rename stands; x became y (structural, formatting may canonicalize).
      src = File.read!(path)
      assert src =~ "y"
      refute src =~ ~r/\bx\b/
    end

    test "a code-edit that CREATES a file is deleted on rollback",
         %{prelude: prelude, dir: dir} do
      # The agent parses a string and writes a tree to a NOT-YET-EXISTENT path,
      # then the program fails: the created file must be removed.
      path = Path.join(dir, "created.ex")
      refute File.exists?(path)

      # code-edit writes a parsed tree to an ABSENT path; the file is absent, so
      # the journal records :prior => :absent and rollback DELETES it on fail.
      tree = Code.parse_tool(%{"src" => "z + 1", "lang" => "elixir"})

      result =
        PtcRunner.Lisp.run(
          ~s|(do (tool/code-edit {:path data/path :lang "elixir" :tree data/tree}) (fail "boom"))|,
          prelude: prelude,
          context: %{"path" => path, "tree" => tree},
          tools: %{"code-edit" => &Code.edit_tool/1},
          on_complete: &Journal.finalize/1,
          filter_context: false,
          caller: :in_process_v1
        )

      assert_failed(result)
      refute File.exists?(path)
    end

    test "multiple edits in one failing program are ALL rolled back",
         %{prelude: prelude, dir: dir} do
      a = Path.join(dir, "m1.ex")
      b = Path.join(dir, "m2.ex")
      File.write!(a, "x + 1")
      File.write!(b, "x + 2")

      # Two DISTINCT targets edited in one program (paths bound as data/a, data/b),
      # then a fail: both must roll back to their originals.
      ops = ~s|[{"op" "update" "pattern" {"node" "identifier" "value" "x"} "template" {"node" "identifier" "value" "y"}}]|

      program = """
      (do
        (tool/code-apply {:path data/a :lang "elixir" :ops #{ops}})
        (tool/code-apply {:path data/b :lang "elixir" :ops #{ops}})
        (fail "boom"))
      """

      assert_failed(run(prelude, program, %{"a" => a, "b" => b}))
      assert File.read!(a) == "x + 1"
      assert File.read!(b) == "x + 2"
    end
  end

  describe "no finalizer = no rollback (additive, opt-in)" do
    test "without on_complete, a failing program leaves the edit in place",
         %{prelude: prelude, dir: dir} do
      path = Path.join(dir, "c.ex")
      File.write!(path, "x + 1")

      result =
        PtcRunner.Lisp.run("(do #{rename_program(path)} (fail \"boom\"))",
          prelude: prelude,
          context: %{"path" => path},
          tools: %{"code-apply" => &Code.apply_tool/1},
          # NO on_complete: the journal records but is never drained.
          filter_context: false,
          caller: :in_process_v1
        )

      assert_failed(result)
      # the write stands (pre-FUP-027 behaviour): the file is the EDITED content.
      assert File.read!(path) =~ "y"
    end
  end
end
