symbol-scoped — target must be `<file>::Symbol`
  symbolClone            renameTo (optional identifier) — Clone destination symbol name (optional)
  symbolDelete           allowSiblingDelete (optional bool) — Allow deleting sibling symbols when removing the last declaration (default: false)
  symbolFindReplace      find (required content) — Text pattern to search for · content (required content) — New file contents (string or string[]) · occurrence (optional occurrence) — Which match to replace: first, last, all, or 1-indexed N (default: all)
  symbolInsertAfter      content (required content) — New file contents (string or string[])
  symbolInsertBefore     content (required content) — New file contents (string or string[])
  symbolMove             direction (required direction) — Move direction: up or down
  symbolRawTextReplace   find (required content) — Text pattern to search for · content (required content) — New file contents (string or string[]) · occurrence (optional occurrence) — Which match to replace: first, last, all, or 1-indexed N (default: all)
  symbolRename           newName (required identifier) — New name for the symbol
  symbolReplace          scope (optional symScope) — Replacement scope: whole (default), body (content MUST include outer braces { ... }), or target · content (required content) — New file contents (string or string[])
  symbolSplice           mode (required spliceMode) — Splice mode: self, up, or down
  symbolTranspose        column (required u32) — 1-indexed column to transpose to
  symbolWrap             content (required content) — New file contents (string or string[])

file-scoped — target is `<file>`
  fileAppend           content (required content) — New file contents (string or string[])
  fileCreate           content (required content) — New file contents (string or string[]) · force (optional bool) — Overwrite if exists (default: false)
  fileDelete          
  fileFindReplace      find (required content) — Text pattern to search for · content (required content) — New file contents (string or string[]) · occurrence (optional occurrence) — Which match to replace: first, last, all, or 1-indexed N (default: all)
  filePatch            diff (required diff) — Unified diff string to apply
  filePrepend          content (required content) — New file contents (string or string[])
  fileRawTextReplace   find (required content) — Text pattern to search for · content (required content) — New file contents (string or string[]) · occurrence (optional occurrence) — Which match to replace: first, last, all, or 1-indexed N (default: all)
  fileWrite            content (required content) — New file contents (string or string[]) · force (optional bool) — Overwrite if exists (default: false)

line-scoped — target is `<file>`
  lineAppend    at (required lineAnchor) — 1-indexed line number · content (required content) — New file contents (string or string[])
  lineInsert    at (required lineAt) — Insertion point: {side: 'before' | 'after', line: <1-indexed>} · content (required content) — New file contents (string or string[])
  linePrepend   at (required lineAnchor) — 1-indexed line number · content (required content) — New file contents (string or string[])
  lineReplace   span (required lineSpan) — Inclusive line range: {start, end?} (1-indexed) · content (required content) — New file contents (string or string[])

heading/css — Markdown/Org/CSS specific
  headingDemote        
  headingPromote       
  headingReplaceBlock   content (required content) — New file contents (string or string[])
  cssRemoveDeadStyle   
  cssRenameClassToken   find (required identifier) — CSS class/id/custom-property token to find · replace (required identifier) — Replacement token
  cssRenameCustomProp   find (required identifier) — CSS class/id/custom-property token to find · replace (required identifier) — Replacement token
  cssRenameIdToken      find (required identifier) — CSS class/id/custom-property token to find · replace (required identifier) — Replacement token

history — no target, dispatched alone (not mixed with other ops)
  undo · redo
