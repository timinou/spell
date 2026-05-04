Retrieve code, files, symbols, or matches using a CodePath target. Supports paths, globs, symbols, regex, and URI schemes.

<instruction>
- `target` accepts:
  - **Bare path**: `"src/foo.ts"` for file content; `"specs/"` for directory listing (auto-expanded).
  - **Glob**: `"src/**/*.ts"` for all TypeScript files under src.
  - **Line slice**: `"foo.ts::§line[1..50]"` for lines 1-50.
  - **Regex filter**: `"foo.ts::§line[text~=\"TODO\"]"` for lines matching pattern.
  - **Code symbol**: `"src/foo.ts::Bar.method"` for specific declaration.
  - **URI schemes**: `"memory://root"`, `"artifact://..."`, `"skill://name"`, `"agent://id"`, `"rule://name"`, `"local://..."`, `"pi://..."`.
- `format` controls output structure:
  - `"node-list"` — structured nodes with LOC#ID anchors, source ranges, metadata.
  - `"locations"` — file:line:col locations only.
  - `"content-only"` — raw content without metadata.
  - `"tree"` — hierarchical tree representation.
  - `"simple-list"` — minimal file/symbol listing.
  - Default for directory targets auto-promotes to fs-listing layout (path + size, `path/`).
- `recursive` (boolean, default: false) — recurse into subdirectories when target is a bare directory path.
- `depth` (integer) — max recursion depth (e.g. `2` = two levels); overrides `recursive`.
- Directory targets auto-attach `#listing` by default, `#tree` or `#tree[depth=N]` when `recursive`/`depth` is set. Use `content: false` to bypass and get the raw dir node.
- Qualifiers (`#listing`, `#tree[depth=N]`, `#stat`, `#raw`) work directly and take precedence over params.
- Projection options:
  - `head` / `tail` — limit from start/end.
  - `offset` / `limit` — skip first N, return M.
- When path typo'd or missing, returns fuzzy filename suggestions.
</instruction>

<output>
- Returns structured nodes with LINE#ID anchors (for `edit` tool), source ranges, and content.
- Bare directory paths produce fs-listing: `<path>  <size>` for files, `<path>/` for dirs, `size=N mtime=ISO` for `#stat`.
- Degenerate single-directory returns include a hint suggesting `recursive: true` or `depth`.
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
get { target: "src/" }
get { target: "src/", recursive: true }
get { target: "src/", depth: 2 }
get { target: "config.json#stat" }
get { target: "memory://root" }
get { target: "artifact://abc123/output.json" }
```
</examples>

<critical>
- You **MUST** use `get` instead of legacy `read`, `grep`, `find`, `ast-grep`, or bash equivalents.
- You **MUST NOT** use `cat`, `grep`, `find`, `rg`, `ls` in bash when `get` can retrieve the target.
- For structural code queries, prefer symbol paths (`foo.ts::ClassName.method`) over line slices.
- For regex searches across files, use glob + line predicates: `"**/*.ts::§line[text~=\"pattern\"]"`.
</critical>
