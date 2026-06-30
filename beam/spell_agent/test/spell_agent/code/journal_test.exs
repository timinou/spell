defmodule SpellAgent.Code.JournalTest do
  @moduledoc """
  Contracts for the FUP-027 restore journal: snapshot-at-write + verdict-driven
  in-worker drain. These tests exercise the journal's PURE process-dictionary
  contract directly (record -> finalize), the same calls `code-edit` (record) and
  the runner's `on_complete` finalizer make inside one worker process. The
  end-to-end "(do (code-edit ...) (fail ...)) restores the file" path is covered
  by the code-edit integration test once the runner hook is wired.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Code.Journal

  setup do
    # Each test starts with a clean journal in THIS process (the journal is
    # process-dict scoped; tests run synchronously so a leftover stack would leak).
    Journal.finalize(:ok)
    :ok
  end

  describe "record + finalize(:ok) — the success path" do
    test "a successful verdict keeps the writes and drops the journal" do
      tmp = new_tmp("edited")
      File.write!(tmp, "after")

      # code-edit recorded the prior state before overwriting.
      Journal.record(%{path: tmp, prior: {:bytes, "before"}})

      assert {:committed, 1} = Journal.finalize(:ok)
      # the file is left as written; commit does not restore.
      assert File.read!(tmp) == "after"
      assert Journal.entries() == []
    end
  end

  describe "finalize(:fail) / finalize(:error) — rollback" do
    test "a failed verdict restores an edited file to its prior bytes" do
      tmp = new_tmp("edited")
      File.write!(tmp, "after")
      Journal.record(%{path: tmp, prior: {:bytes, "before"}})

      assert {:rolled_back, 1} = Journal.finalize(:fail)
      assert File.read!(tmp) == "before"
    end

    test "a failed verdict DELETES a file the run created (prior :absent)" do
      tmp = new_tmp("created")
      File.write!(tmp, "new content")
      # code-edit recorded the target as absent before creating it.
      Journal.record(%{path: tmp, prior: :absent})

      assert {:rolled_back, 1} = Journal.finalize(:error)
      refute File.exists?(tmp)
    end

    test "multiple edits are all-or-nothing; LIFO unwinds re-edits of one path to the true original" do
      a = new_tmp("a")
      b = new_tmp("b")
      File.write!(a, "a-final")
      File.write!(b, "b-final")

      # Two distinct files + a SECOND edit of `a` — recorded newest-first as the
      # program proceeds. LIFO restore must land `a` back at its TRUE original.
      Journal.record(%{path: a, prior: :absent})
      Journal.record(%{path: b, prior: {:bytes, "b-orig"}})
      Journal.record(%{path: a, prior: {:bytes, "a-after-first-edit"}})

      assert {:rolled_back, 3} = Journal.finalize(:fail)
      # b restored to its original bytes; a deleted (its TRUE prior was :absent,
      # reached last because LIFO unwinds the second a-edit first).
      assert File.read!(b) == "b-orig"
      refute File.exists?(a)
    end

    test "rollback is best-effort: an un-restorable entry is skipped, the rest restore" do
      gone = Path.join(System.tmp_dir!(), "spell-journal-missing-#{System.unique_integer([:positive])}/x")
      ok = new_tmp("ok")
      File.write!(ok, "after")

      # `gone`'s parent dir does not exist -> restoring its prior bytes fails; it is
      # skipped (counted as not-restored), and `ok` still restores.
      Journal.record(%{path: gone, prior: {:bytes, "cannot-land"}})
      Journal.record(%{path: ok, prior: {:bytes, "before"}})

      assert {:rolled_back, 1} = Journal.finalize(:fail)
      assert File.read!(ok) == "before"
    end
  end

  describe "idempotency + isolation" do
    test "a second finalize finds an empty stack (drain is idempotent)" do
      tmp = new_tmp("x")
      File.write!(tmp, "after")
      Journal.record(%{path: tmp, prior: {:bytes, "before"}})

      assert {:rolled_back, 1} = Journal.finalize(:fail)
      # second drain: nothing left, no double-restore.
      assert {:committed, 0} = Journal.finalize(:ok)
      assert {:rolled_back, 0} = Journal.finalize(:fail)
    end

    test "entries reflect the recorded stack newest-first" do
      Journal.record(%{path: "/tmp/one", prior: :absent})
      Journal.record(%{path: "/tmp/two", prior: :absent})

      assert [%{path: "/tmp/two"}, %{path: "/tmp/one"}] = Journal.entries()
    end
  end

  defp new_tmp(tag) do
    Path.join(System.tmp_dir!(), "spell-journal-#{tag}-#{System.unique_integer([:positive])}.txt")
  end
end
