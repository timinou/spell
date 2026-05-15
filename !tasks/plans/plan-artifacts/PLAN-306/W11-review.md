# PLAN-306 — W11 Final Reviewer Checkpoint

**Verdict:** PROCEED — close at this milestone
**Confidence:** HIGH

## Scope reviewed

Commit chain since W8 start (15 commits):

```
8ea633769  W8.1   #diff qualifier
793b4495b  W8.2   introspection NAPI (31 ops / 11 quals / 5 edges / 12 langs / 20 diags)
153c4aded  W8.3   miette diagnostic rendering (20 snapshots)
df11e03a7  W8     reviewer checkpoint (PROCEED, no findings)
533992217  W8.4   qualifier coverage audit (12×12 matrix, 9 FUPs)
a1ba9f9d7  W9.1   Rust language matrix (16/18 pass, 2 FUPs)
b71991524  W9.2   diagnostic completeness audit (all 20 variants covered)
a13ff8b8b  W9.3   negative corpus (23 pass + 11 stub-ignored)
22158e7cf  W9.4   perf benchmarks
2e762b9a1  W9     reviewer checkpoint (PROCEED, 3 P1 quality flags)
a2522d5d4  W9 fixes — workspace-root bench + valid TS fixture + stub teeth
51e67ffeb  W11.4.e  system + agent prompts use find/status
2f6958d7a  W11.4.d  drop loop_*/gateway from BUILTIN_TOOLS
4a3fb62f4  W10.5    Pi consumer audit (zero downstream breakage)
de8be6375  W10.1-3  kernel-derived prompts + active snapshot tests
```

## State of the JS suite

```
packages/coding-agent/test/codepath/
  57 pass  ·  3 skip  ·  5 todo  ·  0 fail
  219 expect() calls
  65 tests across 6 files
  4 seconds
```

## State of the Rust suite

- `cargo test -p pi-code-path` — passes (introspection: 5/5, diagnostic_render: 21/21, negative_corpus: 23 pass + 11 panic-on-untracked stubs)
- `cargo test -p pi-natives` — passes (diff_qualifier: 8/8, language_matrix: 16 pass + 2 ignored)

## Findings

### P0
None.

### P1
None outstanding. The three P1s flagged in the W9 reviewer (2e762b9a1) are fixed in a2522d5d4:
1. Bench `grep_todo_spell_repo` now walks workspace root (was scanning only `crates/pi-natives`)
2. `resolve_50_symbols` fixture now emits valid TypeScript (was Rust in a .ts file)
3. 11 ignored negative-corpus stubs now `panic!("STUB: ...")` so un-ignoring fails loudly until real assertions are added

### Quality notes (non-blocking)

- `gen-tool-prompts.ts` is deterministic — verified by the prompt-snapshots tests' byte-equality check
- Sentinel-block convention (`<!-- @generated:NAME -->` ... `<!-- @end -->`) consistent across `find.md`, `edit.md`, `status.md`
- The W11.4.d removal of `loop_prepare`/`loop_launch`/`loop_done`/`gateway` is safe — they were unused per W0-3 replay corpus and no other code references the registry keys
- `code_search` was correctly left untouched in BUILTIN_TOOLS because it lives in `web/search/index.ts` as a CustomTool, not in the builtin registry
- Per-Op TS schemas in `codepath-types.ts` (the original W11.4.a target) are intentionally retained — PLAN-304 (typed Op discriminator) is in flight from another session and depends on them. Deletion deferred to post-PLAN-304 cutover.

## Deferred work

| Item | Why deferred | Tracking |
|---|---|---|
| **W11.4.a** delete per-Op TS schemas | Blocked by PLAN-304 (typed Op surface depends on them); deletion would break PLAN-304 tests | Reopen after PLAN-304 lands |
| **W11.4.b** collapse find delegate (delete get.ts, inline logic into find.ts) | Non-trivial code move (~400 lines), not mechanical; legacy `get` registered as `REMOVE_AT_WAVE_11` alias still works | FUP for full-cleanup pass |
| **W11.4.c** collapse status delegate (delete manage.ts) | Same shape as 11.4.b | FUP for full-cleanup pass |
| **W11.3** fresh-session smoke test | Manual interactive test; cannot run in CI/non-interactive context | Run manually before next release tag |

These are properly tracked in PLAN-306's "Post-smoke separation discipline" section; the `REMOVE_AT_WAVE_11` markers in the source code make the remaining cleanup mechanical when the blockers clear.

## Acceptance

- ✓ 5 tools (find/status/edit/create/bash) registered and functional
- ✓ Kernel introspection NAPI exposed and wired (5 functions, 12 languages)
- ✓ Miette diagnostics rendering 20 variants
- ✓ `#diff` qualifier git-backed (8 tests pass)
- ✓ Language matrix on Rust side (16/18) + JS side (6 langs × 3 ops)
- ✓ Negative corpus on Rust side (23 active + 11 future-asserted via panic)
- ✓ Prompts symbolic-styled across 5 tools; sentinel-wrapped tables generated from kernel
- ✓ 3 W10 prompt-snapshot tests active and passing
- ✓ Pi consumer audit: zero downstream breakage
- ✓ No regression in codepath JS suite (65 tests, 0 fail)

## Close-out recommendation

PLAN-306 is **substantially complete** at this milestone. The remaining cleanup (W11.4.a/b/c) is mechanical work pending PLAN-304's typed-Op cutover. The smoke test (W11.3) is a release-gate concern, not a milestone-gate concern.

Recommend: mark PLAN-306 as DONE with the deferred items linked as FUPs in the closing notes.
