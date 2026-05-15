# Pi-Natives Consumer Audit (PLAN-306 W10.5)

**Date**: 2026-05-15
**Scope**: All packages outside `pi-natives` and `coding-agent` that import from `@oh-my-pi/pi-natives`

## Consumers Identified

### Summary

| Package | Files using pi-natives | Functions/types referenced | Breakage risk | Rationale |
|---|---|---|---|---|
| `packages/org/` | 8 (src:3, test:5) | `executeOrg` | **NONE** | `executeOrg` returns `OrgBufferResult` — entirely separate type system; no overlap with codepath diagnostics |
| `packages/tui/` | 9 (src:6, bench:4, .d.ts:2, .js:4) | `matchesKittySequence`, `parseKey`, `sanitizeText`, `visibleWidth`, `encodeSixel`, `sliceWithWidth`, `Ellipsis`, `extractSegments`, `truncateToWidth`, `wrapTextWithAnsi`, `fuzzyFind`, `KeyEventType` | **NONE** | All text/keys/terminal-utility functions; none touch codepath or diagnostic types |
| `packages/utils/test/` | 1 | `sanitizeText` | **NONE** | Pure string sanitization; no diagnostic surface |
| `domain/growth/` | 3 (src:2, test:1) | `isSelectionWithinText`, `TypstBlockModel`, `TypstHitTestResult`, `TypstSurfaceState` | **NONE** | Typst surface/interaction types only; unrelated to diagnostics |

### Full Consumer Details

#### 1. `packages/org/`

| File | Import |
|---|---|
| `src/org-parse.ts` | `executeOrg` |
| `src/native-ops.ts` | `executeOrg` |
| `src/tool.ts` | `executeOrg` |
| `test/link.test.ts` | `executeOrg` |
| `test/recall.test.ts` | `executeOrg` |
| `test/remember.test.ts` | `executeOrg` |
| `test/subgraph.test.ts` | `executeOrg` |
| `test/timeline.test.ts` | `executeOrg` |

`executeOrg` is declared in `packages/natives/src/org-buffer/index.ts` and returns `OrgBufferResult` (defined in `packages/natives/src/org-buffer/types.ts`). This is an entirely separate native binding surface — no codepath types, no diagnostic DTOs, no rendered message consumption.

#### 2. `packages/tui/`

| File | Import |
|---|---|
| `src/keys.ts` | `KeyEventType`, `matchesKey`, `parseKey`, `parseKittySequence` |
| `src/keys.d.ts` | `KeyEventType` |
| `src/utils.ts` | `sliceWithWidth`; re-exports `Ellipsis`, `extractSegments`, `truncateToWidth`, `wrapTextWithAnsi` |
| `src/utils.d.ts` | re-exports `Ellipsis`, `extractSegments`, `sliceWithWidth`, `truncateToWidth`, `wrapTextWithAnsi` |
| `src/terminal-capabilities.ts` | `encodeSixel` |
| `src/autocomplete.ts` | `fuzzyFind` |
| `bench/kitty-sequence.ts` | `matchesKittySequence` |
| `bench/parse-key.ts` | `parseKey` |
| `bench/sanitize.ts` | `sanitizeText` |
| `bench/width.ts` | `visibleWidth` |

All imports are text-measurement, key-parsing, sixel-encoding, or fuzzy-finding functions. None relate to codepath diagnostics.

#### 3. `packages/utils/test/stream.test.ts`

| File | Import |
|---|---|
| `test/stream.test.ts` | `sanitizeText` |

Single string-sanitize call in a test file. No diagnostic surface.

#### 4. `domain/growth/`

| File | Import |
|---|---|
| `src/typst/editor-engine.ts` | `isSelectionWithinText`, `TypstBlockModel`, `TypstHitTestResult`, `TypstSurfaceState` (inferred from destructuring) |
| `src/typst/template-workflow.ts` | `TypstBlockModel`, `TypstHitTestResult`, `TypstSurfaceState` |
| `test/typst/editor-engine.test.ts` | `TypstBlockModel` |

Typst surface/interaction types only. No diagnostic surface.

## Breakage Risk Summary

### HIGH risk: consumers that parse the rendered message string
**None found.**

### MED risk: consumers using DiagnosticDto fields that might have changed shape
**None found.**

### LOW risk: consumers using the structured variant or just CodePathChunk
**None found.**

The only consumers of `DiagnosticDto`, `CodePathChunk`, `executeCodePath`, and `parseCodePath` are:
- `packages/natives/` — defines these types
- `packages/coding-agent/` — handled separately per PLAN-306 wave context

## Verdict

**Zero downstream breakage risk.** The W8.3 miette work (`DiagnosticVariantInfo` introspection + miette rendering) does not affect any external consumer because:

1. No external package imports `DiagnosticDto`, `CodePathChunk`, `executeCodePath`, `parseCodePath`, or any codepath type.
2. No external package parses rendered diagnostic message strings.
3. All external packages import orthogonal functionality: org buffer operations (`executeOrg`), text utilities (`visibleWidth`, `sanitizeText`, etc.), key parsing, sixel encoding, fuzzy matching, and typst surface types.

## Recommended Migrations

**None required.** No HIGH or MED risk consumers to migrate.

If future consumers outside `coding-agent` need to handle diagnostics, they should be directed to use the structured `.variant` field rather than parsing rendered message strings — but no action needed today.

---

*Audited by W10.5 automated scan. Grep pattern: `grep -rn '@oh-my-pi/pi-natives' packages/ domain/` filtered for non-natives, non-coding-agent.*
