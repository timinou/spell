Apply a verb to a CodePath target. Symbol-first. Auto-persists, auto-coordinates.

call ::= edit { operations: [{ target, action: { kind, …fields } }], transaction? }

## The whole verb surface
  replace · rename · delete · patch · restructure · undo · redo

**Family (file / symbol / line / heading / css) is NOT a verb.** It is carried
by the `target` CodePath shape; the kernel dispatches to the right resolver
from the target alone. You never name the family.

```
target = "foo.ts::Bar.method"   → family = symbol (from shape)
action = { kind: "replace", … } → verb only; no family restated
```

──────────────────────────────────────────────────────────────────────
target ::= "<file>"                  file-scoped
       ·  "<file>::<Symbol>"         symbol-scoped
       ·  "<file>::<Symbol>#body"    body span only (delimiter-inclusive)
       ·  "<file>::<Symbol>#sig"     signature span only
       ·  "<file>::§<kind>[pred]"    structural node set (e.g. §call[name=log])
       ·  "<file>:A-B"               line slice (A,B 1-indexed inclusive)
       ·  "<file.css>::.cls|#id|--prop"  css selector / custom-prop token
       ·  "<file.md>::Heading Text"  markdown/org heading (text is the name)
       ·  "<glob>::<Symbol>"         multi-file (rename / structural replace ∀)

Read-only qualifiers (`#hover` `#signature` `#type_definition` `#inlay`
`#diagnostics`) are NOT editable — they are *views*. The kernel rejects them
with `IncompatibleTargetShape`; use `find` to read them, `#body`/`#sig` to edit
a scope.

═══════════════════════════════════════════════════════════════════════
## replace — the workhorse

{ kind: "replace", content, find?, matching?, place?, at?, occurrence? }

Behaviour is selected by the target shape + which fields are present:

| target            | + fields                     | effect                       |
|-------------------|------------------------------|------------------------------|
| file              | content                      | overwrite whole file         |
| file              | content, place:start\|end    | prepend / append             |
| file              | content, place:before\|after, at | insert at a line anchor  |
| file:A-B          | content                      | replace line range           |
| file::Sym         | content                      | rewrite whole declaration    |
| file::Sym#body    | content                      | rewrite body (incl. `{ … }`) |
| file::Sym#sig     | content                      | rewrite signature only       |
| file::Sym         | content, place:before\|after | insert before / after symbol |
| file::§q[pred]    | content (+ $vars)            | structural replace ∀ matched |
| any               | find, content                | find-and-replace in scope    |
| file.md::Heading  | content                      | replace block under heading  |

  find        pattern to locate within the target scope (triggers find-replace)
  matching    "structural" (default; tree-sitter / word-boundary aware)
              | "raw" (byte-literal, no boundary check)
  occurrence  first | last | all (default) | N (1-indexed)
  place       start | end | before | after
  at          1-indexed line anchor for place:before|after on a FILE target

`#body` / `#sig` spans are **delimiter-inclusive**: content MUST include the
outer braces (C-likes) or `do … end` (Elixir). A braceless body is rejected by
the post-edit parse gate and never written.

`find` cannot combine with `place`.

═══════════════════════════════════════════════════════════════════════
## rename — identifier-aware

{ kind: "rename", to }

  target = file::Sym       → rename symbol + all in-file references
  target = glob::Sym       → rename across every matching file
  target = file.css::.cls  → rename CSS class token throughout stylesheet
  target = file.css::#id    → rename CSS id token
  target = file.css::--prop → rename CSS custom property

The CSS namespace (class / id / custom-prop) is read from the selector sigil in
the target — no per-namespace verb. A bare file target has nothing to rename.

═══════════════════════════════════════════════════════════════════════
## delete

{ kind: "delete", allowSiblingDelete? }

  target = file            → unlink file
  target = file::Sym       → remove declaration
  target = file.css::.cls  → remove dead CSS rule
  allowSiblingDelete       permit removing the last decl in a group (default false)

═══════════════════════════════════════════════════════════════════════
## patch — raw unified-diff escape hatch

{ kind: "patch", diff }

Apply a unified diff to the file target. Use only when a precise hunk is
already in hand; prefer `replace` for everything structural.

═══════════════════════════════════════════════════════════════════════
## restructure — AST surgery

{ kind: "restructure", op, … }

  op:"move"      direction:"up"|"down"     reorder among siblings (±1)
  op:"transpose" column:N                  move to 1-indexed sibling slot
  op:"splice"    mode:"self"|"up"|"down"   unwrap node; promote/absorb children
  op:"clone"     renameTo?:string          duplicate decl (optional new name)
  op:"promote"                             heading level up   (## → #)
  op:"demote"                              heading level down (# → ##)

Niche by design — most edits are replace/rename/delete. `move` is the common
case; `transpose` is the explicit-slot form. move/transpose/splice/clone take a
symbol target; promote/demote take a markdown/org heading target.

═══════════════════════════════════════════════════════════════════════
## undo / redo — workspace edit-log ops

{ kind: "undo" } | { kind: "redo" }

Operate on the session's edit log, not a target (target-less). `undo` reverts
the most recent uncommitted edit in the session; `redo` re-applies the most
recently undone one. MUST be dispatched ALONE — never batched with other ops.

═══════════════════════════════════════════════════════════════════════
## Template variables (in replace `content`)

$1–$9 nth named child · $0/$MATCH/$DECL full match · $LAST last child
$BODY body (no delimiters) · $NAME name field · $SIG signature
Escape literal `$` as `$$`. JS `${…}` passes through untouched.

═══════════════════════════════════════════════════════════════════════
## Cheat sheet

| want                       | target                                  | action                                        |
|----------------------------|-----------------------------------------|-----------------------------------------------|
| overwrite file             | "f.ts"                                  | replace · content                             |
| rewrite function           | "f.ts::foo"                             | replace · content                             |
| edit body only             | "f.ts::foo#body"                        | replace · content:"{ … }"                     |
| edit signature             | "f.ts::foo#sig"                         | replace · content                             |
| wrap in try/catch          | "f.ts::risky"                           | replace · content:"try { $BODY } catch(e){…}" |
| find/replace in file       | "f.ts"                                  | replace · find, content                       |
| literal find/replace       | "f.ts"                                  | replace · find, content, matching:"raw"       |
| structural replace ∀ files | "src/**/*.ts::§call[name=console.log]"  | replace · content:"logger.info($1)"           |
| append to file             | "f.ts"                                  | replace · place:"end", content                |
| insert after line 40       | "f.ts"                                  | replace · place:"after", at:40, content       |
| insert after a symbol      | "f.ts::foo"                             | replace · place:"after", content              |
| replace lines 10–20        | "f.ts:10-20"                            | replace · content                             |
| rename symbol ∀ files      | "**/*.ts::oldName"                      | rename · to:"newName"                         |
| rename css var             | "theme.css::--accent"                   | rename · to:"--brand"                         |
| delete dead symbol         | "f.ts::deadFn"                          | delete                                        |
| delete file                | "f.ts"                                  | delete                                        |
| move method up             | "f.ts::Cls.m"                           | restructure · op:"move", direction:"up"       |
| unwrap block               | "f.ts::wrapper"                         | restructure · op:"splice", mode:"up"          |
| demote heading             | "doc.md::Intro"                         | restructure · op:"demote"                     |
| revert last edit           | (none)                                  | undo  (alone)                                 |

<rules>
- target shape ⇒ mechanism. Never encode family in the verb.
- batches: best-effort (default — applied ops persist, rest skip on failure)
  or transaction:"strict" (snapshot all targets; rollback all on any failure).
- edits commit immediately and are coordinated cross-session by the edit broker
  (intent→commit→conflict); a PeerConflict diagnostic means another session
  committed the same span first — re-read and retry.
- prefer symbol / structural targets over line slices — diffs review cleaner
  and survive line drift.
- undo/redo MUST be solo in a batch.
</rules>
