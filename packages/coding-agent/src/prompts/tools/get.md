Retrieve code, files, symbols, or matches using a CodePath target. Supports paths, globs, symbols, regex, and URI schemes.

<instruction>
- `target` accepts:
  - **Bare path**: `"src/foo.ts"` for whole file or directory listing.
  - **Glob**: `"src/**/*.ts"` for all TypeScript files under src.
  - **Line slice**: `"foo.ts::§line[1..50]"` for lines 1-50.
  - **Regex filter**: `"foo.ts::§line[text~=\"TODO\"]"` for lines matching pattern.
  - **Code symbol**: `"src/foo.ts::Bar.method"` for specific declaration.
  - **URI schemes**: `"memory://root"`, `"artifact://..."`, `"skill://name"`, `"agent://id"`, `"rule://name"`, `"local://..."`, `"pi://..."`.
- `format` controls output structure:
  - `"node-list"` (default) — structured nodes with CID prefixes, source ranges, metadata.
  - `"locations"` — file:line:col locations only.
  - `"content-only"` — raw content without metadata.
  - `"tree"` — hierarchical tree representation.
  - `"simple-list"` — minimal file/symbol listing.
- Projection options:
  - `head` / `tail` — limit from start/end.
  - `offset` / `limit` — skip first N, return M.
- When path typo'd or missing, returns fuzzy filename suggestions.
</instruction>

<output>
- Returns structured nodes with LINE#ID anchors (for `edit` tool), source ranges, and content.
- Directory targets return formatted listings with modification times.
- Binary files return metadata; images can be viewed via `#image` qualifier.
- URI targets resolve via internal schemes and delegate to downstream dialects.
</output>

<examples>
```
get { target: "src/server.ts" }
get { target: "src/**/*.test.ts" }
get { target: "src/config.ts::§line[1..50]" }
get { target: "src/app.ts::App.handleRequest" }
get { target: "**/*.ts::§line[text~=\"useState\"]", limit: 20 }
get { target: "memory://root" }
get { target: "artifact://abc123/output.json" }
get { target: "src/", format: "simple-list" }
```
</examples>

<critical>
- You **MUST** use `get` instead of legacy `read`, `grep`, `find`, `ast-grep`, or bash equivalents.
- You **MUST NOT** use `cat`, `grep`, `find`, `rg`, `ls` in bash when `get` can retrieve the target.
- For structural code queries, prefer symbol paths (`foo.ts::ClassName.method`) over line slices.
- For regex searches across files, use glob + line predicates: `"**/*.ts::§line[text~=\"pattern\"]"`.
</critical>
