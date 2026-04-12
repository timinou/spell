Performs structural code search via native ast-grep.

<instruction>
- Use when syntax shape matters more than raw text.
- Narrow `path`; add `glob` for relative filtering.
- In mixed repos, pair `path` + `glob` + explicit `lang`.
- `pat` is required and must include at least one non-empty AST pattern.
- Multiple patterns run in one pass; results are merged before `offset`/`limit`.
- Use `sel` only for contextual pattern mode.
- In contextual mode, results return the selected node, not the wrapper.
</instruction>

<critical>
- For variadic captures, use `$$$NAME`, not `$$NAME`.
- Patterns must parse as a single valid AST node; wrap invalid standalones in context or use `sel`.
- If ast-grep reports multiple AST nodes, wrap method snippets in valid context and use `sel` for the inner node.
- Patterns match AST structure, not text.
- Repeated metavariables must match identical code.
- For TypeScript declarations and methods, prefer shapes that tolerate unneeded annotations.
- Metavariables must be the sole content of an AST node; partial-text metavariables do not work.
- `$$$` captures are lazy; place the most specific node after the capture to control its end.
- `$_` is a non-capturing wildcard for any single node.
- Search the right declaration form before concluding absence.
- For proof-of-existence, prefer a looser contextual search such as `pat: ["executeBash"]` with `sel: "identifier"`.
</critical>

<output>
- Returns grouped matches with file path, byte range, line/column ranges, and metavariable captures.
- Includes summary counts and parse issues when present.
</output>

<examples>
- Find all console logging calls in one pass:
  `{"pat":["console.log($$$)","console.error($$$)"],"lang":"typescript","path":"src/"}`
- Contextual pattern with selector — match only the identifier `foo`, not the whole call:
  `{"pat":["foo()"],"sel":"identifier","lang":"typescript","path":"src/utils.ts"}`
- Match a TypeScript method body fragment by wrapping it in parseable context and selecting the method node:
  `{"pat":["class $_ { async execute($INPUT: $_) { $$$BEFORE; const $PARSED = $_.parse($INPUT); $$$AFTER } }"],"sel":"method_definition","lang":"typescript","path":"src/tools/todo.ts"}`
</examples>

<critical>
- `pat` is required.
- Set `lang` explicitly when path spans mixed-language trees.
- Avoid repo-root AST scans for language-specific targets; narrow `path` first.
- Treat parse issues as query failure, not absence.
- For broad open-ended exploration across subsystems, use Task tool with explore subagent first.
</critical>