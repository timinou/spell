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

heading/css — Markdown/Org/CSS specific
  headingDemote · headingPromote · headingReplaceBlock · cssRemoveDeadStyle · cssRenameClassToken · cssRenameCustomProp · cssRenameIdToken

history — no target, dispatched alone (not mixed with other ops)
  undo · redo
