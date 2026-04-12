Performs structural AST-aware rewrites via native ast-grep.

<instruction>
- Use for codemods and structural rewrites where plain text replace is unsafe.
- Narrow `path`; add `glob` for relative filtering.
- In mixed repos, set `lang` and keep `path`/`glob` narrow.
- Treat parse issues as scoping or pattern-shape signals.
- Metavariables captured in each rewrite pattern are substituted into that entry's rewrite template.
- For variadic captures, use `$$$NAME`, not `$$NAME`.
- Rewrite patterns must parse as valid AST; wrap standalones in context or switch to contextual `sel`.
- In contextual `sel` mode, match and replacement target the selected node, not the wrapper.
- For TypeScript declarations and methods, prefer shapes that tolerate unneeded annotations.
- Metavariables must be the sole content of an AST node; partial-text metavariables do not work in patterns or rewrites.
- Each matched rewrite is a 1:1 structural substitution.
</instruction>

<output>
- Returns replacement summary, per-file replacement counts, and change diffs.
- Includes parse issues when files cannot be processed.
</output>

<examples>
- Rename a call site across a directory:
  `{"ops":[{"pat":"oldApi($$$ARGS)","out":"newApi($$$ARGS)"}],"lang":"typescript","path":"src/"}`
- Rewrite a TypeScript method body fragment by wrapping it in parseable context and selecting the method node:
  `{"ops":[{"pat":"class $_ { async execute($INPUT: $_) { $$$BEFORE; const $PARSED = $_.parse($INPUT); $$$AFTER } }","out":"class $_ { async execute($INPUT: $_) { $$$BEFORE; const $PARSED = $SCHEMA.parse($INPUT); $$$AFTER } }"}],"sel":"method_definition","lang":"typescript","path":"src/tools/todo.ts"}`
</examples>

<critical>
- `ops` **MUST** contain at least one concrete `{ pat, out }` entry.
- If the path spans multiple languages, set `lang` explicitly.
- Parse issues mean the rewrite request is malformed or mis-scoped.
- For one-off local text edits, prefer the Edit tool instead of AST edit.
</critical>