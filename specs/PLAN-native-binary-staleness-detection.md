# PLAN: Native Binary Staleness Detection

## Context

When Rust source files under `crates/` are modified but the native binary
`packages/natives/native/pi_natives.dev.node` is not rebuilt, the session
silently runs with a stale binary. This causes confusing runtime errors
(e.g. "Missing required field: source" when the Rust API changed but the
old binary is still loaded).

Root cause discovered in commit `13efa39f4` (refactor: unify code and org
buffer architecture): the Rust `cmd_parse_items` was changed to accept
`file` via `read_org_source()`, but the old binary still expected `source`
(inline text). The TypeScript layer had already been updated to pass `file`.
Binary was built at 18:09, source changed at 18:20 -- 11 minutes of drift.

## Settled Decisions

1. Add `nativeAddonPath` export to `packages/natives/src/native.ts`
2. Add `checkNativeStaleness(cratesDir: string)` export to `packages/natives/src/native.ts`
3. The function checks mtime of loaded binary vs max mtime of `.rs`, `Cargo.toml`, `Cargo.lock`, `build.rs` files under the provided `cratesDir`
4. Only runs when `$env.PI_DEV` is set
5. Returns `NativeStalenessResult | null` (see interface below)
6. Caller in `packages/coding-agent/src/main.ts` pushes a warning to `notifs` if stale
7. Warning message includes the stale file and suggests `bun --cwd=packages/natives run build:native`
8. Warn only -- do not auto-rebuild

## Implementation

### BUG-246: Add dev-mode native binary staleness detection at startup

**Files**: `packages/natives/src/native.ts`, `packages/coding-agent/src/main.ts`
**Effort**: 2h | **Priority**: #B | **Layer**: infra

#### Part 1: Store loaded binary path (packages/natives/src/native.ts)

- Add module-level `let loadedAddonPath: string | undefined`
- In `loadNative()`, after a candidate loads successfully (~line 232 where
  `console.log` prints the path), set `loadedAddonPath = candidate`
- Export `loadedAddonPath` as a named export

#### Part 2: Staleness check function (packages/natives/src/native.ts)

```typescript
export interface NativeStalenessResult {
  stale: boolean;
  binaryPath: string;
  binaryMtime: number;
  newestSourceMtime: number;
  newestSourceFile: string;
}

export function checkNativeStaleness(cratesDir: string): NativeStalenessResult | null
```

Behavior:
- Return `null` if `!$env.PI_DEV` or `!loadedAddonPath`
- `fs.statSync(loadedAddonPath).mtimeMs` for the binary mtime
- Walk `cratesDir` recursively, collecting mtimes of files matching:
  `*.rs`, `Cargo.toml`, `Cargo.lock`, `build.rs`
- Find the file with max mtime
- Return the result with `stale: newestSourceMtime > binaryMtime`
- Wrap in try/catch -- return `null` on any error (don't break startup)

Performance: ~230 files in `crates/`, synchronous stat is fine for dev-mode
startup (< 10ms).

#### Part 3: Wire into startup (packages/coding-agent/src/main.ts)

- Import `checkNativeStaleness` from `@oh-my-pi/pi-natives`
- After the `notifs` array is created (~line 601), before session creation,
  call the check with the project root's `crates/` directory:
  `path.join(getProjectDir(), "crates")`
- If `result?.stale`, push a warning notif:
  `Native binary is stale (newest source: {file}, {age} newer than binary). Run: bun --cwd=packages/natives run build:native`
- Use `getProjectDir()` from `@oh-my-pi/pi-utils` for the project root

Note: `getProjectDir()` returns the monorepo root in dev mode. The `crates/`
directory is always at the monorepo root.

#### Part 4: Re-export from package

- `packages/natives/src/native.ts` exports the `native` singleton. The new
  exports (`loadedAddonPath`, `checkNativeStaleness`, `NativeStalenessResult`)
  need to be importable from `@oh-my-pi/pi-natives`.
- The index.ts re-exports sub-modules but NOT native.ts directly. Need to add
  `export { checkNativeStaleness, loadedAddonPath, type NativeStalenessResult } from "./native"` to index.ts.

### Edge Cases

- Binary doesn't exist (first checkout): `loadedAddonPath` undefined, returns null
- `crates/` doesn't exist (non-dev install): returns null
- Symlinked binary: `statSync` follows symlinks, which is correct
- `.rs` file not part of pi-natives (e.g. embedding worker): false positive is acceptable
- Concurrent builds: mtime comparison is racy but worst case is a false positive

### Test Plan

Unit test in `packages/natives/test/staleness.test.ts`:
- Create temp dir with fake `.rs` files and a fake binary
- Binary newer than sources -> `stale: false`
- Source newer than binary -> `stale: true`
- Missing binary path -> returns `null`
- Empty crates dir -> returns `null` or `stale: false`
- Non-existent crates dir -> returns `null`

### Acceptance Criteria

1. In dev mode with a stale binary, startup shows a warning with "stale" and rebuild command
2. In dev mode with a fresh binary, no warning
3. In release mode (no PI_DEV), no check runs at all
4. `bun check:ts` passes
5. Manual verification: touch a `.rs` file, start spell, see the warning

## Verification

```
bun check:ts
bun test packages/natives/test/staleness.test.ts
# Manual: touch crates/pi-natives/src/lib.rs && spell (should show warning)
```

## Execution Manifest

Single item, no dependencies:
1. BUG-246: Implement staleness detection (native.ts + main.ts + test)
