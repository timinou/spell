Read files · search code · navigate symbols · fetch artifacts.
∴ single tool for retrieval → replaces read · grep · find · cat · sed · ls · head · tail · wc · rg · ast-grep.

<target>
path     `"src/foo.ts"`                      → file
dir      `"specs/"`                          → listing   (`recursive: true` | `depth: N` → tree)
glob     `"src/**/*.ts"`                     → multi-file
slice    `"foo.ts:50"` head N · `":-50"` tail N · `":80-130"` range · `":80-"` A→EOF · `":80+50"` A+N
symbol   `"foo.ts::Class.method"`            → body
         `"foo.ts::Class.method:±5"`         → body ±5
grep     `"**/*.ts::§line[text~=\"TODO\"]"`    → regex ∀ files
line     `"foo.ts::§line[42]"`               → 1 line + LINE#ID anchor
meta     `"foo.ts#stat"`                     → size · mtime · lineCount
uri      `"artifact://<session>/<agent>/<tool>/<n>.<ext>"`  ∀ sessions
         `memory://` · `skill://` · `agent://` · `rule://` · `local://` · `pi://`
</target>

<rules>
- slice ∈ target string. ✗ `head`/`tail`/`offset`/`limit` params.
- symbol slice: bare digits = abs file lines (`Sym:80-90`); `±` = rel to symbol bounds (`Sym:±5`).
- code     → symbol path > line slice
- xfile re → glob + `§line[text~="…"]` > multi-grep
- anchors  → `LINE#ID` from fresh `get` → consumed by `edit`. ✗ fabricate.
- budget   → 25k tok (`tools.getSpillThreshold`). ≤ budget inline · > budget → artifact + tail.
</rules>

<examples>
get { target: "src/server.ts" }
get { target: "src/server.ts:80-130" }
get { target: "src/server.ts::App.handle" }
get { target: "src/server.ts::App.handle:±5" }
get { target: "src/**/*.test.ts" }
get { target: "**/*.ts::§line[text~=\"TODO\"]" }
get { target: "src/", recursive: true }
get { target: "config.json#stat" }
get { target: "artifact://abc/main/bash/3.txt" }
</examples>