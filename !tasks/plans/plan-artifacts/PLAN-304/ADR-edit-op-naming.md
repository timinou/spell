# ADR — Edit Op surface naming and shape

**Status:** accepted 2026-05-11 · supersedes ad-hoc `Action` flat enum
**Parent:** `[[id:PLAN-304-type-correct-edit-op-surface-discriminat]]`
**Follow-up cutover:** `[[id:FUP-084-edit-op-hard-cutover-remove-legacy-actio]]`

## Locked decisions

### D-1 Soft deprecation
Legacy kind strings (`write`, `delete`, `rename`, `wrap`, `findAndReplace`,
`rawTextReplace`, `splice`, `move`, `clone`, `transpose`, `insertBefore`,
`insertAfter`, `append`, `prepend`, `replace`, `patch`, `promote`, `demote`,
`replaceCodeBlock`, `renameClassToken`, `renameIdToken`,
`renameCustomProperty`, `removeDeadStyle`) accepted via TS-side
adapter for one minor release. Adapter emits a deprecation note in the
tool result text. Hard removal is FUP-084.

### D-2 Naming — camelCase, target-prefix
Every new Op variant is `<targetFamily><Capability>`. Target families:

| family | meaning | locator constraint |
|---|---|---|
| `file` | whole-file or filesystem-level mutation | bare `FsLocator`, no query, no qualifier |
| `line` | line-anchored within a file | bare `FsLocator`; LINE#ID anchor mandatory |
| `symbol` | tree-sitter declaration mutation | `has_target_query == true` |
| `css` | CSS-procedural mutation | dialect == `css` |
| `heading` | markdown/org heading mutation | dialect ∈ {`md`, `org`} |

### Variant list (canonical)

```
fileCreate              FileTarget   content: Content, force: bool
fileWrite               FileTarget   content: Content, force: bool
fileDelete              FileTarget
fileAppend              FileTarget   content: Content
filePrepend             FileTarget   content: Content
filePatch               FileTarget   diff: String

lineReplace             FileTarget   span: LineSpan, content: Content
lineInsert              FileTarget   at: LineAt (Before|After of LineAnchor), content: Content
lineAppend              FileTarget   at: LineAnchor, content: Content
linePrepend             FileTarget   at: LineAnchor, content: Content

symbolReplace           SymbolTarget scope: SymScope (Whole|Body|Sig), content: Content
symbolRename            SymbolTarget new_name: Identifier
symbolWrap              SymbolTarget content: Content
symbolDelete            SymbolTarget allow_sibling_delete: bool
symbolInsertBefore      SymbolTarget content: Content
symbolInsertAfter       SymbolTarget content: Content
symbolFindReplace       SymbolTarget find: Content, content: Content, occurrence: Occurrence
symbolRawTextReplace    SymbolTarget find: Content, content: Content, occurrence: Occurrence
symbolMove              SymbolTarget direction: Direction
symbolClone             SymbolTarget rename_to: Option<Identifier>
symbolSplice            SymbolTarget mode: SpliceMode
symbolTranspose         SymbolTarget column: u32

cssRenameClassToken     CssTarget    find: String, replace: String
cssRenameIdToken        CssTarget    find: String, replace: String
cssRenameCustomProp     CssTarget    find: String, replace: String
cssRemoveDeadStyle      CssTarget

headingPromote          HeadingTarget
headingDemote           HeadingTarget
headingReplaceBlock     HeadingTarget content: Content
```

### D-2 SymScope shape

```rust
pub enum SymScope {
    Whole,   // replace entire declaration (default; was `kind:"write"` w/o scope)
    Body,    // replace declaration body only (was `kind:"write" scope:"body"`)
    Sig,     // replace signature only (new capability surfaced)
}
```

`SymScope` is a proper enum (NOT a string). Serializes to `"whole" | "body" | "sig"`.

### D-3 Procedural resolver split

`CssResolver` and `HeadingResolver` are new modules under
`crates/pi-natives/src/code_path/`. Each owns its variant family
exhaustively. `CodeResolverImpl` only handles `symbol*` ops.

### D-4 Schema source-of-truth

TypeBox is canonical. Rust hand-mirrors the schema as `Op::from_json`
deserializer. A parity test (Wave 4) enumerates every variant, builds a
sample on each side, and asserts both sides accept exactly the same
field set. `schemars`-based Rust schema gen is a separate FUP.

## Target newtype constructors (Rust)

```rust
impl FileTarget {
    pub fn new(cp: CodePath) -> Result<Self, Diagnostic> {
        if cp.has_target_query() {
            return Err(Diagnostic::new(
                DiagnosticVariant::IncompatibleTargetShape,
                "fileTarget rejects symbol/qualifier targets; use a bare path",
            ));
        }
        if !matches!(cp.locator, Locator::Fs(_)) {
            return Err(Diagnostic::new(
                DiagnosticVariant::IncompatibleTargetShape,
                "fileTarget requires an FsLocator (no URI)",
            ));
        }
        Ok(FileTarget(cp))
    }
}

impl SymbolTarget {
    pub fn new(cp: CodePath) -> Result<Self, Diagnostic> {
        if cp.query.is_none() {
            return Err(Diagnostic::new(
                DiagnosticVariant::IncompatibleTargetShape,
                "symbolTarget requires a ::Symbol query segment",
            ));
        }
        if !matches!(cp.locator, Locator::Fs(_)) {
            return Err(Diagnostic::new(
                DiagnosticVariant::IncompatibleTargetShape,
                "symbolTarget requires an FsLocator",
            ));
        }
        Ok(SymbolTarget(cp))
    }
}

impl CssTarget {
    pub fn new(cp: CodePath, dialect_for: impl Fn(&Path) -> &'static str) -> Result<Self, Diagnostic> {
        let ft = FileTarget::new(cp.clone()).or_else(|_| SymbolTarget::new(cp.clone()).map(|st| FileTarget(st.0)))?;
        // dialect resolved from FsLocator extension via dialect_for
        // (caller supplies registry lookup)
        // …
        Ok(CssTarget(ft.0))
    }
}
// HeadingTarget: same shape, dialect ∈ {md, org}
```

`CssTarget`/`HeadingTarget` accept either bare file (whole-file
procedural op) or symbol target (specific rule/heading); they
explicitly check dialect.

## TS schema shape (TypeBox)

```ts
const fileTargetSchema = Type.String({
  pattern: "^(?!.*::).+$",
  description: "Bare file path; MUST NOT contain '::'",
});

const symbolTargetSchema = Type.String({
  pattern: "^.+::.+$",
  description: "Symbol target; MUST contain '::Symbol[.member]'",
});

const symScopeSchema = Type.Union([
  Type.Literal("whole"),
  Type.Literal("body"),
  Type.Literal("sig"),
]);

export const fileWriteOp = Type.Object({
  kind: Type.Literal("fileWrite"),
  target: fileTargetSchema,
  content: contentSchema,
  force: Type.Optional(Type.Boolean()),
});

export const symbolReplaceOp = Type.Object({
  kind: Type.Literal("symbolReplace"),
  target: symbolTargetSchema,
  scope: Type.Optional(symScopeSchema),  // default Whole
  content: contentSchema,
});

// … one Type.Object per kernel Op variant …

export const editOpSchema = Type.Union([
  fileCreateOp, fileWriteOp, fileDeleteOp, fileAppendOp, filePrependOp, filePatchOp,
  lineReplaceOp, lineInsertOp, lineAppendOp, linePrependOp,
  symbolReplaceOp, symbolRenameOp, symbolWrapOp, symbolDeleteOp,
  symbolInsertBeforeOp, symbolInsertAfterOp,
  symbolFindReplaceOp, symbolRawTextReplaceOp,
  symbolMoveOp, symbolCloneOp, symbolSpliceOp, symbolTransposeOp,
  cssRenameClassTokenOp, cssRenameIdTokenOp, cssRenameCustomPropOp, cssRemoveDeadStyleOp,
  headingPromoteOp, headingDemoteOp, headingReplaceBlockOp,
]);
```

## Legacy adapter (Wave 3)

Pre-validation pass in `edit.ts`. Runs BEFORE TypeBox validation.

```ts
function adaptLegacy(op: any): { op: any; deprecation?: string } {
  if (typeof op?.action?.kind !== "string") return { op };
  const k = op.action.kind;
  const hasSymbol = typeof op.target === "string" && op.target.includes("::");
  const map: Record<string, (hasSymbol: boolean, action: any) => string | null> = {
    write: (s, a) => s ? "symbolReplace" : "fileWrite",
    delete: (s) => s ? "symbolDelete" : "fileDelete",
    rename: () => "symbolRename",
    wrap: () => "symbolWrap",
    findAndReplace: () => "symbolFindReplace",
    rawTextReplace: () => "symbolRawTextReplace",
    splice: () => "symbolSplice",
    move: () => "symbolMove",
    clone: () => "symbolClone",
    transpose: () => "symbolTranspose",
    insertBefore: () => "symbolInsertBefore",
    insertAfter: () => "symbolInsertAfter",
    append: (s) => s ? null : "fileAppend",
    prepend: (s) => s ? null : "filePrepend",
    replace: () => "lineReplace",
    patch: () => "filePatch",
    promote: () => "headingPromote",
    demote: () => "headingDemote",
    replaceCodeBlock: () => "headingReplaceBlock",
    renameClassToken: () => "cssRenameClassToken",
    renameIdToken: () => "cssRenameIdToken",
    renameCustomProperty: () => "cssRenameCustomProp",
    removeDeadStyle: () => "cssRemoveDeadStyle",
  };
  const fn = map[k]; if (!fn) return { op };
  const newKind = fn(hasSymbol, op.action);
  if (!newKind) return { op };  // shape couldn't be translated; let validator reject

  // Move `target` from outer op into the action; flatten nested action fields
  const translated = { kind: newKind, target: op.target, ...op.action };
  delete translated.action;

  // Special case: kind:"write" + scope:"body" → symbolReplace{scope:Body}
  if (k === "write" && translated.scope === "body") {
    translated.scope = "body";  // SymScope literal — already correct
  }

  return {
    op: translated,
    deprecation: `kind "${k}" is deprecated; use "${newKind}". Legacy adapter will be removed in next minor.`,
  };
}
```

## Open questions resolved

| Question | Resolution |
|---|---|
| Should `target` move into the Op variant, or stay alongside? | INTO the variant. TS schema enforces target shape per `kind` via pattern. |
| Should `lineReplace`/`lineInsert` exist as separate kinds or stay under `replace`? | SEPARATE. Mental model is "I'm editing lines, not symbols." |
| `symbolFindReplace` vs `symbolRawTextReplace` — keep both? | YES. find = regex-aware (current behavior); rawText = literal. Both have distinct dispatch paths. |
| Where do `idempotent` / `occurrence` live? | At Op level (not action) for cross-batch settings; inside action for per-variant settings (occurrence on Find/RawText only). |
| Old `Action` enum staying or going? | Stays for one minor as the bridge target; deleted in FUP-084. |
