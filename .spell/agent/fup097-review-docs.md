# FUP-097 Documentation Review — Agent-Facing Surface + TS Bridge

**Reviewer**: docs-consistency
**Date**: 2026-05-26
**Scope**: `find.md`, `edit.md`, `system-prompt.md`, `codepath-types.ts`, `edit.ts`, `pi-code-graph/src/lib.rs`, memory concept

---

## Summary

6 findings: 0 P0, 0 P1, 4 P2, 2 P3.
Core merge surface (grammar, smart-merge table, recipes) is solid.
Issues cluster around stale documentation after `#hover_inferred` fold:
`find.md` lists deprecated qualifier as active, `system-prompt.md` still
describes `#hover` as written-only, `edit.md` omits read-only qualifier
rejection entirely. Memory concept is pre-FUP-097.

---

### P2-1: `#hover_inferred` listed as active read-only qualifier in find.md

**File**: `packages/coding-agent/src/prompts/tools/find.md:105`
**Severity**: P2
**Confidence**: high

**Issue**: The read-only semantic qualifiers list on line 105 includes
`#hover_inferred` alongside `#type_definition`, `#type_def`, `#signature`,
`#inlay`, `#diagnostics`. But `#hover_inferred` is deprecated — the kernel
returns a `Deprecated` diagnostic, not `SemanticReadOnly`. The deprecation
(and migration to `#hover [source=semantic]`) is already documented in the
paragraph immediately above (lines 102-103). Listing it again in the
read-only set is confusing: an agent sees both "this is deprecated, use X"
and "this is read-only, use find to inspect". The deprecation message is
the one that actually fires.

**Fix**: Remove `#hover_inferred` from the read-only qualifier list on line
105. The paragraph above already covers the deprecation + migration path.
Result:

```
Read-only semantic qualifiers (`#type_definition`,
`#type_def`, `#signature`, `#inlay`, `#diagnostics`) cannot be used as
`edit` targets — they describe a *view* of code, not a region. Use
`find { … #qual }` to inspect.
```

**Why it matters**: Agent that sees `#hover_inferred` in the read-only list
might try `find { ::S #hover_inferred }` expecting read-only behavior, get
a deprecation diagnostic instead, and waste a turn re-parsing.

---

### P2-2: edit.md missing read-only qualifier rejection documentation

**File**: `packages/coding-agent/src/prompts/tools/edit.md`
**Severity**: P2
**Confidence**: high

**Issue**: edit.md has no mention that semantic read-only qualifiers
(`#type_definition`, `#type_def`, `#signature`, `#inlay`, `#diagnostics`)
are rejected at edit time with `IncompatibleTargetShape`. The cheat sheet
shows `#body` and `#sig` as valid edit scopes, which implies other
qualifiers might also work. An agent trying `edit { target:
"foo.ts::x#type_definition", action: { kind: "replace", content: "..." } }`
will hit a cryptic `IncompatibleTargetShape` error. The restriction IS
documented in find.md, but edit.md has no cross-reference.

**Fix**: Add a rule to the rules section (after line 47) or a footnote to
the cheat sheet:

```
- read-only qualifiers (`#type_definition`, `#type_def`, `#signature`,
  `#inlay`, `#diagnostics`) cannot be edit targets — use `find` to
  inspect them (see find.md for details)
```

**Why it matters**: edit is the agent's primary mutation tool. Silent
failures on semantically valid targets waste turns and erode trust. The
agent should know ahead of time which qualifiers are inspection-only.

---

### P2-3: system-prompt.md describes `#hover` as "written signature line" — stale after FUP-097

**File**: `packages/coding-agent/src/prompts/system/system-prompt.md:215`
**Severity**: P2
**Confidence**: high

**Issue**: Line 215 says:
```
- `find { target: "foo.ts::Bar.method#hover" }` — written signature line
```
After FUP-097, `#hover` is a smart-merge that consults BOTH the written
(tree-sitter) and inferred (LSP) backends and returns the best answer.
Describing it as "written signature line" misleads the agent into thinking
`#hover` only returns tree-sitter data, causing the agent to fall back to
the `lsp` tool for inferred types that `#hover` already provides.

**Fix**: Update to reflect smart-merge behavior:
```
- `find { target: "foo.ts::Bar.method#hover" }` — signature + inferred type (smart-merge)
```

**Why it matters**: The system prompt is the agent's primary reference for
tool capabilities. A stale description means the agent won't use `#hover`
for type inference queries, undermining the entire FUP-097 fold.

---

### P2-4: Memory concept CON-pi-code-graph-semantic-backend-layer--pl stale after FUP-097

**File**: `.spell/memory/concepts/pi-code-graph-semantic-backend-layer--pl.org`
**Severity**: P2
**Confidence**: medium

**Issue**: Three stale references to `#hover_inferred`:
- Line 15 (architecture diagram): `agent calls find { ::Sym #hover_inferred }` — should show `#hover [source=semantic]` or `#hover` with smart-merge dispatch
- Line 51 (design rule 1): `#hover_inferred / #type_definition / [type_aware] / #diagnostics / #signature / #inlay` — should list `#hover` not `#hover_inferred`
- No FUP-097 entry in the Sequenced-after section or as a DISTILLED_FROM relation

**Fix**: Update lines 15 and 51 to reflect FUP-097 fold. Add FUP-097 to the
sequenced-after notes or DISTILLED_FROM relations.

**Why it matters**: Memory concepts feed future planning sessions. Stale
architecture diagrams propagate the old two-qualifier mental model.

---

### P3-5: `normalise_for_compare` dead export from pi-code-graph

**File**: `crates/pi-code-graph/src/lib.rs:39`
**Severity**: P3
**Confidence**: high

**Issue**: `normalise_for_compare` is re-exported from `pi-code-graph`
but has zero external callers. All usages are module-internal: `merge_hover`
(same `semantic::mod.rs`) and unit tests. It's a whitespace-normalization
helper with no general-purpose utility outside the hover merge path.

**Fix**: Remove from the `pub use` in `lib.rs`, or mark `#[doc(hidden)]`.

**Why it matters**: Dead exports clutter the public API surface and create
false signals for future consumers. Low impact since it's a utility fn.

---

### P3-6: codepath-types.ts edit target description omits qualifier restrictions

**File**: `packages/coding-agent/src/tools/codepath-types.ts:264-267`
**Severity**: P3
**Confidence**: medium

**Issue**: The `editOperationSchema.target` TypeBox description says:
> "Stable edit target ID: '<file>' for file roots or
> '<file>::Symbol.member' for declarations. ..."

It doesn't mention that `#type_definition`, `#signature`, `#inlay`,
`#diagnostics` qualifiers are rejected. The TS schema is the agent's
type-level API reference — adding a note here would catch the issue
before the kernel round-trip.

**Fix**: Append to the description:
> "...Read-only qualifiers (`#type_definition`, `#signature`, `#inlay`,
> `#diagnostics`) are rejected — use `find` to inspect them."

**Why it matters**: Low — the kernel's error message is clear. But a
type-level hint saves a round-trip.

---

## What's correct

- Smart-merge table in find.md is precise, self-explanatory, and matches
  the `merge_hover` implementation exactly (HoverOutcome variants map 1:1
  to table rows).
- `[source=both]` default behavior clearly documented.
- Recipes table has concrete `[source=graph]` and `[source=semantic]`
  examples that complement the merge-matrix paragraph.
- FUP-097 deprecation paragraph is clear about migration path.
- `HoverSource` enum is clean (only Graph/Semantic variants; no
  RedirectedToGraph or BothMerged cruft).
- `edit.ts` correctly delegates existence checks to the Rust layer after
  FUP-097 (TS-layer pre-flight gate removed).
- `codepath-types.ts` editSchema correctly includes the unified verbs
  (replace/rename/delete) alongside legacy OpKinds.
- No dead references to `RedirectedToGraph` or `BothMerged` anywhere in
  the codebase — those were reviewer suggestions only.
- Generated `_generated/find-recipes.md` correctly omits semantic
  qualifiers (they're in the manual section of find.md).
