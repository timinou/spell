Apply Op to target. Symbol-first. Auto-persists.

call ::= edit { operations: [{ target, action: { kind, …fields } }] }

target ::= `<file>`  (file-scoped Ops)
       ·  `<file>::<Symbol>`  (symbol-scoped Ops)

<!-- @generated:edit-ops -->
symbol-scoped — target must be `<file>::Symbol`
  symbolClone            (renameTo?)
  symbolDelete           (allowSiblingDelete?)
  symbolFindReplace      (find, content) (occurrence?)
  symbolInsertAfter      (content)
  symbolInsertBefore     (content)
  symbolMove             (direction)
  symbolRawTextReplace   (find, content) (occurrence?)
  symbolRename           (newName)
  symbolReplace          (content) (scope?)
  symbolSplice           (mode)
  symbolTranspose        (column)
  symbolWrap             (content)

file-scoped — target is `<file>`
  fileAppend             (content)
  fileCreate             (content) (force?)
  fileDelete             
  fileFindReplace        (find, content) (occurrence?)
  filePatch              (diff)
  filePrepend            (content)
  fileRawTextReplace     (find, content) (occurrence?)
  fileWrite              (content) (force?)

line-scoped — target is `<file>`
  lineAppend             (at, content)
  lineInsert             (at, content)
  linePrepend            (at, content)
  lineReplace            (span, content)

heading — Markdown/Org specific
  headingDemote · headingPromote · headingReplaceBlock

css specific
cssRemoveDeadStyle · cssRenameClassToken · cssRenameCustomProp · cssRenameIdToken

history — no target, dispatched alone (not mixed with other ops)
  undo · redo
<!-- @end -->

<patterns>
| want                          | call                                                                |
|-------------------------------|---------------------------------------------------------------------|
| insert after fn               | `target: "foo.ts::handleX"  action: { kind: "symbolInsertAfter", content: "…" }` |
| rename + update callers       | loop: `find { ::X def→ }` → `edit` each call site                   |
| rewrite test count            | `target: "foo.rs"  action: { kind: "fileFindReplace", find: "29", content: "31" }` |
| rewrite block                 | `target: "foo.ts::Bar.method"  action: { kind: "symbolReplace", content: "…" }`   |
| revert last                   | `action: { kind: "undo" }`                                          |
| atomic multi-file             | `operations: [...]  transaction: "strict"` (all-or-nothing rollback) |
</patterns>

<rules>
- target shape ↔ Op family: kernel returns IncompatibleTargetShape if mismatched (e.g. `symbolReplace` with bare path)
- occurrence ∈ { first, last, all, N } · default = unique-or-fail
- edits commit immediately. undo/redo via this tool.
- batches: best-effort (default — keep applied, skip failing) or strict (snapshot, rollback on any failure)
- prefer symbol targets over file targets for surgical edits — diffs review better
</rules>
