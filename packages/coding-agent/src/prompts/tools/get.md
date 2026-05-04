Retrieve code, files, symbols, or matches using a CodePath target. Supports paths, globs, symbols, regex, and URI schemes.

<instruction>
- `target` is a CodePath string: bare file (`src/foo.ts`), glob (`**/*.test.ts`), symbol (`src/foo.ts::Bar.baz`), regex (`src/** :: §line[text~="TODO"]`), or URI (`memory://root`, `artifact://…`, `skill://name`).
- `format` controls output shape: `node-list` (default), `locations`, `content-only`, `tree`, `simple-list`.
- Slice large files with `head`, `tail`, `offset`, `limit`. Use at most one of head/tail per call.
- `root` overrides the working directory for relative target resolution.
- Code symbol resolution works after dialects are wired; use `file.ts::SymbolName` for precise addressing.
- Internal URI schemes resolve to their downstream dialects: `memory://` → Markdown/Org, `agent://` → JSON, `skill://` → FS/Markdown, `artifact://` → Text/Markdown by extension.
- If a target does not match exactly, the resolver may return a suffix-fallback diagnostic suggesting the nearest valid locator.
</instruction>

<output>
- Returns a node list with canonical locators, ranges, kinds, and optional content.
- Binary content is staged to the artifact store and returned as an `artifact://` handle.
- Results may carry limit-reached flags; paginate with `offset`/`limit` if truncated.
</output>

<critical>
- You **MUST** use `get` instead of legacy `read`, `find`, `grep`, `ast-grep`, or `code read`.
- You **MUST NOT** invoke `cat`, `head`, `grep`, or `rg` via Bash when `get` covers the need.
- For open-ended searches requiring multiple rounds, use Task tool with explore subagent instead.
</critical>

<examples>
```
get { target: "src/api.ts" }
get { target: "src/api.ts", head: 50 }
get { target: "**/*.rs", format: "simple-list" }
get { target: "src/api.ts :: UserService", format: "content-only" }
get { target: "src/** :: §line[text~=\"FIXME\"]" }
get { target: "memory://root/skills/coding/SKILL.md" }
get { target: "artifact://session-id/agent/tool/1.png" }
```
</examples>
