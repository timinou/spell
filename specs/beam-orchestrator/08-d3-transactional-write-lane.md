# D3: Transactional Write Lane — implementation record

**Date**: 2026-06-11
**Status**: SHIPPED (W1+W2+W3), reviewer-cleared each wave.
**Plan**: PLAN-333. **Reads with**: `06-execute-substrate.md` (D-3/E4),
`07-execute-substrate-status.md` (E4 was the last alive-and-scary class).

## What it kills

Error class **E4 — partial effects**: a PTC-Lisp `execute` program that mutates
then errors left the repo half-changed (`(create A)(edit B)(boom)` → A and B on
disk, program reports failure, agent may retry → double-apply). The only error
class that silently CORRUPTS the repo.

## Mechanism (and why it differs from the plan's first assumption)

The plan first assumed staging via `BufferRegistry.edit_transaction` + the broker
`MultiCommit`. Investigation (agent://7-TxnSubstrate) found the Spell `edit`/`create`
tools **bypass pi-code-engine** — they call the kernel which writes **directly to
disk**. The broker MultiIntent path coordinates pi-code-engine *buffer* edits across
*sessions* — a different axis (the ptc write tools never touch it).

∴ D3 = **optimistic-apply + program-scoped snapshot/rollback at the Node dispatch
layer**, lifting `edit.ts`'s existing per-call strict-transaction snapshot/restore
to whole-program scope. NOT deferred-commit (no staging VFS exists). Writes land as
the program runs; a program error rolls them all back.

```
program ok        → peer result_frame → client resolves → COMMIT (drop snapshots)
program fail/err  → peer error_frame  → client throws    → ROLLBACK (restore all)
```

## The three waves

```
W1  TransactionScope + TransactionRegistry + exec_id threading
    - exec_id flows BEAM→client(onToolCall execId)→dispatcher; onExecId hook keys
      the scope to the program's wire id BEFORE its first tool_call.
    - dispatcher captures FS-write snapshots (first-touch-only, per-path serialized)
      before each edit/create; ExecuteTool commits on success / rolls back on catch.
    - files: transaction.ts (NEW), tool-dispatch.ts, client.ts, execute.ts.
    - review fixes (4): ENOENT-vs-unreadable (unreadable left untouched, never
      deleted); re-init retry rolls back the prior scope (no stranded snapshots);
      create path keyed verbatim (not edit-locator-stripped); per-path capture
      promise serializes concurrent same-path captures (pmap fan-out).

W2  Mixed-effect guard (D3.4) — DYNAMIC, at dispatch (the authoritative check)
    - TransactionScope.guard(tool, effect): throws MixedEffectError the instant a
      scope holds BOTH a rollback-able FS write (edit/create) AND a non-rollback-able
      mutation (org set / memory save / todo_write / exec / network).
    - review fix (P1, fail-OPEN): the first design was a STATIC regex preflight; it
      could not see a write tool invoked in VALUE position
      (`(let [w tool/org] (w {:command "set"}))`) → mixed program admitted → torn
      state. Moved the guarantee to the dynamic dispatch-layer guard (sees every
      call by resolved name+effect); demoted the static `assertTransactionSafe` to a
      non-gating advisory (avoids its string/comment false-positives — FUP-117).

W3  Crash-window recovery journal
    - TransactionJournal: persists the snapshot set per program BEFORE each write;
      clears on clean settle; on ExecuteTool startup, sweep() restores any journal
      stranded by a PRIOR crashed process (kill -9 mid-program self-heals).
    - best-effort + non-fatal: a journal failure never blocks a program; it only
      narrows the crash window. Skips current-pid (live) journals; tolerates
      unreadable-marker snapshots and unparseable files.
    - location: ~/.spell/execute-txn-journal.
    - review fixes (3): [P1 cross-process clobber] sweep now gates recovery on a
      pid LIVENESS probe (process.kill(pid,0)) not pid-equality — a foreign
      journal whose pid is still ALIVE belongs to a concurrent process and is
      SKIPPED (restoring it would revert that process's in-flight writes);
      [P2 pid-reuse] the filename carries a per-launch NONCE (txn-<pid>-<nonce>-
      <execId>) so a recycled pid can't masquerade as our own live journal;
      [P2 torn write] write() is atomic (temp-file + rename) so a crash mid-write
      or concurrent pmap-fan-out write never leaves a torn JSON record.

Tests: packages/coding-agent/src/tools/ptc-runtime/transaction.test.ts (39:
touchedFiles, scope snapshot/commit/rollback, the dynamic guard incl. the
value-position evasion, the journal incl. the decisive crash-recovery sweep, and
real-BEAM create-edit-BOOM-leaves-repo-clean).

## Honest residuals (filed, not hidden)

- **FUP-116**: concurrent execute PROGRAMS writing the SAME file (cross-program
  atomicity) — D3 is single-program; the broker MultiIntent path covers this and is
  stubbed-ready. Single-session sequential use (the common case) is fully handled.
- **FUP-117**: the static `assertTransactionSafe` advisory's regex false-positives
  (strings/comments, reordered keys). The DYNAMIC guard is the guarantee; the static
  one is not wired as a gate. Best fixed by a BEAM `tool_calls` introspection method
  (also sharpens W4's extractToolCalls).

## Relationships

Closes E4 → the alive-and-scary error inventory (#1 partial effects) is now empty
(#2 leak, #3 nil already done; #4 NIF-panic = PLAN-334, not live). Unblocks
**FUP-112 (W4-write)**: a stored program may now mutate transactionally.
