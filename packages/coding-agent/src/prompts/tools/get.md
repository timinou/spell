Retrieve code, files, symbols, or matches using a CodePath target. Supports paths, globs, symbols, regex, and URI schemes.

<instruction>
- `target` accepts:
  - **Bare path**: `"src/foo.ts"` for file content; `"specs/"` for directory listing (auto-expanded).
  - **Glob**: `"src/**/*.ts"` for all TypeScript files under src.
  - **Line shorthand**: `"foo.ts:50"` head N, `"foo.ts:-50"` tail N, `"foo.ts:80-130"` range, `"foo.ts:80-"` A→EOF, `"foo.ts:80+50"` A+N. Or `"foo.ts::§line[1..50]"` axis form.
  - **Regex filter**: `"foo.ts::§line[text~=\"TODO\"]"` for lines matching pattern.
  - **Code symbol**: `"src/foo.ts::Bar.method"` for specific declaration.
  - **URI schemes**: `"memory://root"`, `"artifact://..."`, `"skill://name"`, `"agent://id"`, `"rule://name"`, `"local://..."`, `"pi://..."`.
  - **URI vs codepath**: `<scheme>://<rest>` is a URI; everything past the first `::` is codepath syntax against the resolved resource. Filesystem-backed resources support `::§line[]`, `::Symbol`, `#stat`, `#tree`. Virtual resources (embedded docs, in-memory state) drop the suffix with a `[note]` warning.
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
- Slicing is part of the target string (no separate params): `path:N` head, `path:-N` tail, `path:A-B` range, `path:A-` from-A, `path:A+N` N-from-A.
- Symbol + slice: bare digits = absolute file lines (`Sym:80-90`); `+`/`-` digits = relative to symbol bounds (`Sym:±5`, `Sym:-2..+10`).
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
get { target: "src/server.ts" }                      # full file
get { target: "src/server.ts:50" }                   # first 50 lines
get { target: "src/server.ts:-50" }                  # last 50 lines
get { target: "src/server.ts:80-130" }               # lines 80..130
get { target: "src/server.ts:80-" }                  # line 80 to EOF
get { target: "src/server.ts:80+50" }                # 50 lines from 80
get { target: "src/server.ts::App.handleRequest" }   # symbol body
get { target: "src/server.ts::App.handle:±5" }       # symbol ±5 lines
get { target: "src/server.ts::App.handle:80-90" }    # absolute slice within symbol
get { target: "src/**/*.test.ts" }                   # glob
get { target: "**/*.ts::§line[text~=\"TODO\"]" }     # grep across files
get { target: "src/server.ts::§line[42]" }           # single line with LINE#ID anchor
get { target: "config.json#stat" }                   # size, mtime, lineCount
get { target: "src/", recursive: true }              # tree
get { target: "memory://root" }                      # URI
get { target: "artifact://abc123/output.json" }      # URI
```
</examples>

<critical>
- You **MUST** use `get` instead of legacy `read`, `grep`, `find`, `ast-grep`, or bash equivalents.
- You **MUST NOT** use `cat`, `grep`, `find`, `rg`, `ls`, `sed`, `awk`, `head`, `tail`, `wc -l` in bash when `get` can retrieve or slice the target.
- Slicing lives in the target string: `path:N` head, `path:-N` tail, `path:A-B` range, `path:A-` from-A, `path:A+N` N-from-A. Do NOT pass `head`/`tail`/`offset`/`limit` params — the schema rejects them.
- Symbol + slice sign convention: bare digits = absolute file lines (`Sym:80-90`), `+`/`-` digits = relative to symbol bounds (`Sym:±5`).
- For structural code queries, prefer symbol paths (`foo.ts::ClassName.method`) over line slices.
- For regex searches across files, use glob + line predicates: `"**/*.ts::§line[text~=\"pattern\"]"` (renders as `LINE: content`).
- For a single line with an editable LINE#ID anchor, use `"foo.ts::§line[N]"`.
</critical>
