Apply Op to target. Symbol-first. Auto-persists. 3 verbs: `replace`, `rename`, `delete`.

call ::= edit { operations: [{ target, action: { kind, …fields } }] }

target ::= `<file>`  (file-scoped)
       ·  `<file>::<Symbol>`  (symbol-scoped)
       ·  `<file>::<Symbol>#body|#sig`  (scoped)
       ·  `<glob>`  (multi-file)

**Read-only qualifiers** (`#hover` / `#hover_inferred` / `#type_definition` /
`#type_def` / `#signature` / `#inlay` / `#diagnostics`) are NOT valid edit
targets — they describe a *view* of code (smart-merge type display,
diagnostics, etc.), not a code region. The kernel rejects them with
`IncompatibleTargetShape` and a hint pointing at `#body` / `#sig` (for
editing a scope) or `find { target: "…" }` (for reading the view).
Query `find` for inspection; use `edit` only with `#body` / `#sig`.

**Body/sig scope is delimiter-inclusive.** `#body` (or `{scope:"body"}`)
replaces the *entire* body span a `find …#body` read returns, including the
block delimiters: braces for C-likes (`{ … }`), `do … end` for Elixir. Your
`content` must therefore include those delimiters — a braceless body is
rejected (and reverted) by the post-edit parse gate, never written. `#sig`
replaces the signature up to (not including) the body. Both accept either the
`foo#body` qualifier or the `{scope:"body"|"sig"}` action field; they are
equivalent.

## Cheat Sheet

| want | target | action |
|------|--------|--------|
| rewrite whole function | `"file.ts :: foo"` | `{ kind: "replace", content: "function foo() { … }" }` |
| change function body | `"file.ts :: foo#body"` | `{ kind: "replace", content: "{ return 42; }" }` |
| change signature only | `"file.ts :: foo#sig"` | `{ kind: "replace", content: "function foo(x: number) " }` |
| rename everywhere | `"**/*.ts :: oldName"` | `{ kind: "rename", content: "newName" }` |
| wrap in try/catch | `"file.ts :: risky"` | `{ kind: "replace", content: "try { $BODY } catch(e) { throw new SafeError(e); }" }` |
| add annotation above | `"file.ts :: func"` | `{ kind: "replace", content: "@deprecated\n$DECL" }` |
| replace pattern in file | `"file.ts"` | `{ kind: "replace", find: "old", content: "new" }` |
| structural replace across files (find nodes matching a CodePath query, replace their content with template) | `"src/**/*.ts :: §call_expression[name=console.log]"` | `{ kind: "replace", content: "logger.info($1)" }` |
| prepend to file | `"file.ts"` | `{ kind: "replace", place: "start", content: "// @ts-check\n" }` |
| append to file | `"file.ts"` | `{ kind: "replace", place: "end", content: "\n// footer" }` |
| overwrite file | `"file.ts"` | `{ kind: "replace", content: "export const X = 1;" }` |
| delete dead symbol | `"file.ts :: deadFunc"` | `{ kind: "delete" }` |
| delete file | `"file.ts"` | `{ kind: "delete" }` |

## Template Variables

In `content`, `$VAR` placeholders are substituted with values from the matched AST node.

| var | resolves to |
|-----|------------|
| `$1` — `$9` | Nth named child of the matched node |
| `$0` | Full matched text (alias `$MATCH`) |
| `$LAST` | Last named child |
| `$BODY` | Body text of a declaration (stripped of delimiters) |
| `$NAME` | Name field of a declaration |
| `$SIG` | Signature — everything before the body |
| `$DECL` | Full declaration text (alias `$MATCH`) |
| `$MATCH` | Full text of the matched node |

Escape literal `$` with `$$`. JS template syntax `${…}` passes through unchanged.

<rules>
- target shape determines mechanism: kernel dispatches to symbol/file/line/heading/CSS resolver automatically
- `find` field on `replace` triggers structural find-and-replace within each matched node
- `place: "start"|"end"` on file target controls prepend/append
- edits commit immediately; undo/redo via `action: { kind: "undo" }` dispatched alone
- batches: best-effort (default) or `transaction: "strict"` (snapshot, rollback on failure)
- prefer symbol targets over file targets for surgical edits — diffs review better
</rules>