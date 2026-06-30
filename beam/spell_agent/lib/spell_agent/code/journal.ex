defmodule SpellAgent.Code.Journal do
  @moduledoc """
  A process-scoped restore journal for `code-edit` / `code-apply` writes (FUP-027).

  ## Why this exists

  `code-edit` is the ONLY file writer in the BEAM agent: there is no `execute`
  tool and no tracked `edit`/`create` primitives here (that transactional layer
  lives in the Spell *harness*, a different system). So a successful `code-edit`
  write is FS-atomic + parse-gated + empty-guarded (W6) but does NOT participate
  in any all-or-nothing rollback. A program that edits a file and then `(fail …)`s
  leaves the file changed. This journal closes that gap.

  ## The contract — snapshot at write, drain in-worker by verdict

  Before overwriting a target, `code-edit` calls `record/1` with the target's
  PRIOR state (its bytes, or `:absent` for a freshly-created file). The entry
  lands in a process-dictionary stack.

  CRITICAL process fact (empirically verified): the sandbox evaluates a program
  in a SPAWNED WORKER process (`PtcRunner.Sandbox.execute` -> `Process.spawn`),
  and native tools run INSIDE that worker. So `code-edit`'s `record/1` AND the
  program's `(fail …)` happen in the SAME worker process — but a CALLER that
  invoked `Lisp.run` is a DIFFERENT process and never sees this dictionary. The
  journal therefore drains IN-WORKER, driven by the post-eval verdict, via a
  finalizer the runner runs after eval and before the worker exits
  (`Lisp.run(…, on_complete: &finalize/1)`).

    * `finalize(:ok)`    — the program SUCCEEDED: discard the journal (writes stand).
    * `finalize(:fail)` / `finalize(:error)` — the program FAILED: restore every
      recorded target to its prior state, newest-first (LIFO, so re-edits of one
      file land back at the true original), then clear. A file edited then
      re-created is restored; a file CREATED by the run (prior `:absent`) is
      deleted.

  ## No active finalizer = plain write (best-effort)

  `record/1` ALWAYS stacks (the worker dict is fresh per run, so there is nothing
  to bracket). When no `on_complete` finalizer is wired, the stack is simply never
  drained and dies with the worker — a `code-edit` keeps the pre-FUP-027 behaviour:
  an FS-atomic write, no rollback. Rollback is opt-in by wiring the finalizer; it
  is purely additive and never changes a successful write's outcome.

  ## Best-effort

  Every restore is wrapped: a target that cannot be rewritten (gone, permission)
  is logged and skipped, never raised — a rollback failure must not mask the
  program's own failure. The journal is an enhancement, never a dependency of the
  write succeeding.
  """

  require Logger

  @key :__spell_code_journal__

  @typedoc "A recorded target's prior state: its bytes, or `:absent` (did not exist)."
  @type prior :: {:bytes, binary()} | :absent

  @typedoc "One journal entry: the target path + the state to restore it to."
  @type entry :: %{path: String.t(), prior: prior()}

  @doc """
  Record a target's prior state before `code-edit` overwrites it.

  Always stacks the entry in the worker's process dictionary (the worker dict is
  fresh per run, so there is no scope to bracket). The prior is captured by the
  CALLER (`code-edit`, which already read the file for the edit) and handed in, so
  the journal does no extra I/O on the hot path. Returns `:ok`.
  """
  @spec record(entry()) :: :ok
  def record(%{path: path, prior: prior}) when is_binary(path) do
    Process.put(@key, [%{path: path, prior: prior} | entries()])
    :ok
  end

  @doc """
  Drain the journal by the program's post-eval verdict, IN THE WORKER.

  Wired as `Lisp.run(…, on_complete: &SpellAgent.Code.Journal.finalize/1)`, the
  runner calls this after eval, before the worker exits — the only point with both
  the recorded entries (same process) and the verdict in hand.

    * `:ok`            — the program SUCCEEDED: drop the journal, writes stand.
    * `:fail`/`:error` — the program FAILED: restore every target newest-first
      (LIFO), then clear. Returns the count of targets restored.

  Returns `{:committed, n}` on success (n = writes kept) or `{:rolled_back, n}` on
  failure (n = targets restored). Idempotent: a second call finds an empty stack.
  """
  @spec finalize(:ok | :fail | :error) :: {:committed, non_neg_integer()} | {:rolled_back, non_neg_integer()}
  def finalize(:ok) do
    n = length(entries())
    Process.put(@key, [])
    {:committed, n}
  end

  def finalize(verdict) when verdict in [:fail, :error] do
    stack = entries()
    Process.put(@key, [])
    restored = Enum.reduce(stack, 0, fn entry, n -> if restore(entry), do: n + 1, else: n end)
    {:rolled_back, restored}
  end

  @doc "The current recorded entries (newest-first). Mostly for tests/telemetry."
  @spec entries() :: [entry()]
  def entries do
    case Process.get(@key) do
      list when is_list(list) -> list
      _ -> []
    end
  end

  # Restore one entry to its prior state. `:absent` -> the run created the file, so
  # delete it; `{:bytes, b}` -> rewrite the prior bytes. Best-effort: any failure
  # is logged and reported as `false` (not restored), never raised.
  defp restore(%{path: path, prior: :absent}) do
    case File.rm(path) do
      :ok ->
        true

      {:error, :enoent} ->
        true

      {:error, reason} ->
        Logger.warning("[code-journal] rollback: could not delete #{path}: #{inspect(reason)}")
        false
    end
  end

  defp restore(%{path: path, prior: {:bytes, bytes}}) do
    case File.write(path, bytes) do
      :ok ->
        true

      {:error, reason} ->
        Logger.warning("[code-journal] rollback: could not restore #{path}: #{inspect(reason)}")
        false
    end
  end
end
