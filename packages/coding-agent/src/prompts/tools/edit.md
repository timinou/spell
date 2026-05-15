Apply Op to target. Symbol-first. Auto-persists.

call ::= edit { operations: [{ target, action: { kind, …fields } }] }

target ::= `<file>`  (file-scoped Ops)
       ·  `<file>::<Symbol>`  (symbol-scoped Ops)

<ops>
symbol-scoped — target must be `<file>::Symbol`
  symbolReplace      replace declaration body  (scope: whole|body|sig)
  symbolRename       rename declaration         (newName)
  symbolWrap         wrap in outer syntax       (content with $BODY placeholder)
  symbolDelete       remove declaration
  symbolInsertBefore insert sibling before
  symbolInsertAfter  insert sibling after
  symbolFindReplace  search within declaration  (find, content, occurrence?)
  symbolMove         drag sibling up/down       (direction)
  symbolSplice       inline / extract           (mode)

file-scoped — target is `<file>`
  fileCreate         new file                   (force?)
  fileWrite          overwrite                  (force?)
  fileDelete
  fileAppend         · filePrepend
  fileFindReplace    search whole file          (find, content, occurrence?)
  filePatch          unified diff               (diff)

heading/css — Markdown/Org/CSS specific
  headingPromote · headingDemote · headingReplaceBlock
  cssRenameClassToken · cssRenameIdToken · cssRenameCustomProp · cssRemoveDeadStyle

history — no target, dispatched alone (not mixed with other ops)
  undo · redo
</ops>

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
