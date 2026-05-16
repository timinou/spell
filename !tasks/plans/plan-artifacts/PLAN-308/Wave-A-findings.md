# PLAN-308 Wave A — Consolidated audit findings

**Status:** complete, gate passed → Wave B unblocked
**Commits:**
- `bac7e2f43` Op serde readiness (A1 patches)
- `9d0d4b09a` pre-Wave-B fixes (A2 force-bug + A4 create.ts)

## Verdict

`proceed` to Wave B. No blockers. Three findings landed as commits before Wave B:
1. Op field-level camelCase renames + round-trip proptest (A1)
2. `force` field forward bug in normalizeStructuralAction (A2)
3. `create.ts` legacy `kind: "create"` → `kind: "fileCreate"` (A4)

## Key answer for Wave C

> **Q:** Can Wave C TS emit `Type.Literal('fileWrite')` and have kernel deserialize it without translation?
> **A:** Yes. `#[serde(tag = "kind", rename_all = "camelCase")]` + three field-level rename attrs land the discriminated-union deserialize natively. Verified via 8-test round-trip proptest covering all 31 OpKind variants.

## A1 — Op serde readiness

| check | state |
|---|---|
| Op has `#[serde(tag = "kind", rename_all = "camelCase")]` | ✓ (was already correct) |
| `SymbolRename::new_name` → `newName` | ✓ (A1 patched) |
| `SymbolDelete::allow_sibling_delete` → `allowSiblingDelete` | ✓ (A1 patched) |
| `SymbolClone::rename_to` → `renameTo` | ✓ (A1 patched) |
| `proptest` dev-dep | ✓ (A1 added) |
| Round-trip test all 31 OpKind variants | ✓ (A1 created `tests/op_roundtrip_proptest.rs`) |
| `cargo test -p pi-code-path` | 57 pass / 0 fail / 11 ignored |

## A2 — Op::from_legacy lossy cases

4 lossy-info cases. All have accept-loss rationale or are naturally fixed by Wave C bypassing Action:

| Action variant | Op produced | Lost | Disposition |
|---|---|---|---|
| `Write` (symbol target) | `SymbolReplace` | `force` field; `scope:Body/Sig` unreachable from legacy | Wave C sends Op directly; Op::SymbolReplace already has scope field. Natural fix. |
| `Clone` | `SymbolClone` | `direction`, `line` | Accept loss: vestigial Action fields, no known callers |
| `Transpose` | `SymbolTranspose` | `line` | Accept loss: transpose operates on symbol, not specific line |
| `InsertBefore/After` | `SymbolInsertBefore/After` | `pos`, `line` | Accept loss: symbol-scoped insertions ignore LINE#ID by design |

Adapter bug found: `force` was silently dropped in `normalizeStructuralAction` — 1-line fix landed in `9d0d4b09a`.

## A3 — normalizeStructuralAction disposition

Total entries: **31** (30 in newToLegacyKind + 1 derived from at.side).

| classification | count | post-cutover disposition |
|---|---|---|
| identity | 0 | — |
| rename-only | 24 | dies for free when Wave C sends Op JSON directly (Rust already accepts camelCase) |
| field-rename | 6 | dies for free — Op enum already uses TS-side field names (newName, renameTo, replace, span, at) per ADR D-2; verified for newName/renameTo/allowSiblingDelete in A1 |
| side-adjusted | 1 | dies for free — Op::LineInsert has `at: LineAt` enum (not separate kind+pos); TS already sends `at` correctly |
| **TOTAL** | **31** | **all die — no residual TS adapter for field shapes** |

### What `legacyKindAdapter` (Wave C) actually handles

Only **legacy kind strings** in agent input. Translation table:

```
"create"           → "fileCreate"
"write"            → "fileWrite" if bare target, "symbolReplace" if ::symbol
"delete"           → "fileDelete" if bare, "symbolDelete" if ::symbol
"append"           → "fileAppend" if bare, route-by-anchor if has LineSpan
"prepend"          → "filePrepend" if bare, "linePrepend" if has anchor
"rename"           → "symbolRename" (rename Action.content → newName)
"wrap"             → "symbolWrap"
"findAndReplace"   → "symbolFindReplace" if ::, "fileFindReplace" otherwise
"rawTextReplace"   → "symbolRawTextReplace" if ::, "fileRawTextReplace" otherwise
"splice"           → "symbolSplice"
"move"             → "symbolMove"
"clone"            → "symbolClone" (rename Action.content → renameTo)
"transpose"        → "symbolTranspose"
"insertBefore"     → "symbolInsertBefore" if ::, "lineInsert" with at.side="before" if has LINE#ID
"insertAfter"      → "symbolInsertAfter" if ::, "lineInsert" with at.side="after" if has LINE#ID
"patch"            → "filePatch"
"replace"          → "lineReplace" (translate pos/end → span)
"promote"          → "headingPromote"
"demote"           → "headingDemote"
"replaceCodeBlock" → "headingReplaceBlock"
"renameClassToken" → "cssRenameClassToken" (translate content → replace)
"renameIdToken"    → "cssRenameIdToken" (translate content → replace)
"renameCustomProperty" → "cssRenameCustomProp" (translate content → replace)
"removeDeadStyle"  → "cssRemoveDeadStyle"
```

Adapter emits ONE deprecation note in tool result text. Lives at edit.ts handler entry.

### Dead code identified

`isLineIdAction` (L62-69) + `isPatchAction` (L72-73) check legacy kind strings. For new-style Op input, both always return false → routing always hits `#executeStructural`. These are reachable only by direct legacy-format calls. Wave C deletes these branches.

## A4 — Legacy kind string usage

| category | sites | action |
|---|---|---|
| Tests in `edit.test.ts` | 8 | migrate-with-Wave-C (rewrite as Op-format JSON) |
| Prompts (`packages/coding-agent/src/prompts/`) | 0 | clean |
| Production code | 1 (`create.ts:119`) | migrated 9d0d4b09a → `fileCreate` |
| LSP protocol domain (`lsp/edits.ts`, `lsp/types.ts`) | 6 | NOT actionable — different schema (TextDocumentEdit/CreateFile/RenameFile/DeleteFile) |
| JSDoc reference (`codepath-types.ts:367`) | 1 | Wave D cleanup |
| Rust Action constructors (production) | 1 (`napi.rs:491 Op::from_legacy`) | the legitimate adapter; survives Wave D as legacy-input fallback |
| Rust Action constructors (tests) | ~12 | migrate-with-Wave-D |

### SCOPE EXPANSION DISCOVERED: code_buffer.rs

A4 surfaced a second NAPI dispatch path:

- `executeCodePath` (napi.rs:324) → Action JSON → Op::from_legacy → dispatch_op (PLAN-304/308 path)
- `executeCodeBuffer` (code_buffer.rs:2156) → direct dispatch on legacy kind strings, ~57 sites

**Consumers of `executeCodeBuffer`:**
- `packages/coding-agent/src/session/edit-coordinator.ts::callCodeBuffer` — session-bound buffer commands (save, replace_content, outline)
- `packages/coding-agent/src/tools/managed-code-buffer.ts:106-114` — uses `{ kind: "write" }` for atomic file-create via buffer

**This is a separate concern from PLAN-308's edit-tool-wire-format scope.** It's the session-state primitive for managed buffers. However:

- If Wave D `#[deprecated]`s `Action`, code_buffer.rs becomes the largest consumer of deprecated code.
- Long-term unification requires code_buffer.rs to also dispatch via `Op` OR Action stays partially alive.

### Decision deferred to Wave D entry

Three options surface for Wave D:

1. **D-strict (clean):** absorb code_buffer.rs refactor into Wave D — convert internal dispatch to Op. ~57 sites, moderate-to-heavy effort, but achieves the "kernel has one grammar" ideal.

2. **D-relaxed (pragmatic):** Wave D only deprecates the edit-tool path. code_buffer.rs continues using Action internally. Wave D' filed as separate plan for code_buffer cutover. Risk: parallel grammars persist longer.

3. **D-redirect (architectural):** managed-code-buffer.ts migrates from `callCodeBuffer({ kind: "write" })` to `executeCodePath({ kind: "fileCreate" })`. If managed-code-buffer is the only consumer of code_buffer's edit dispatch, delete the edit branch in code_buffer.rs. Risk: semantics may differ (session-state coherence) — needs investigation.

**Recommendation:** option **3** if managed-code-buffer.ts is the only `kind:"write"` consumer of `callCodeBuffer`. Investigate at Wave D entry. Otherwise option **2** with explicit Wave D' filed.

## What Wave B inherits

- Op enum + serde tagging confirmed camelCase-clean ✓
- Field names match TS-side ADR D-2 names ✓
- 31-variant proptest exists as regression net ✓
- Adapter bugs that would have masked Wave B work are fixed ✓
- Test fixture `edit.test.ts` (8 legacy-kind sites) flagged for Wave C migration ✓

Wave B starts on a foundation where the kernel side is ready to accept Op JSON directly. Wave B's job is to expose the variant *schema* (not just kinds) via NAPI so Wave C can generate TS bindings.
