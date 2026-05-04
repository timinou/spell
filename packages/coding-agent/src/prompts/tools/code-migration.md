Legacy tool to CodePath v3 migration guide.

On cutover the eight standalone legacy tools and the `code` subcommand surface are deleted. Every behavior they provided is reproduced by `get`, `edit`, `manage`, or `create` with a CodePath target.

| Legacy tool | New tool | Projection sugar | Canonical CodePath |
|---|---|---|---|
| `find "*.ts"` | `get` | `get { target: "**/*.ts" }` | `**/*.ts` |
| `find "*.ts" --hidden=false` | `get` | `get { target: "**/*.ts" }` | `**/*.ts -[¶hidden]` |
| `read foo.ts` | `get` | `get { target: "foo.ts" }` | `foo.ts#raw` |
| `read foo.ts offset=50 limit=100` | `get` | `get { target: "foo.ts", head: 100, … }` | `foo.ts :: §line[50..150]#text` |
| `read dir/` | `get` | `get { target: "dir/" }` | `dir/#listing` |
| `read foo.pdf` | `get` | `get { target: "foo.pdf" }` | `foo.pdf#text` |
| `read foo.docx` | `get` | `get { target: "foo.docx" }` | `foo.docx#text` |
| `read img.png` | `get` | `get { target: "img.png" }` | `img.png#image` |
| `read artifact://…` | `get` | `get { target: "artifact://…" }` | `artifact://…#raw` |
| `read rule://my-rule` | `get` | `get { target: "rule://my-rule" }` | `rule://my-rule#text` |
| `grep "useState" src/` | `get` | `get { target: "src/** :: §line[text~=\"useState\"]" }` | `src/** :: §line[text~="useState"]` |
| `grep --post 3 "TODO"` | `get` | `get { target: "§line[text~=\"TODO\"]", context: { post: 3 } }` | `§line[text~="TODO"] >>[0..3]` |
| `grep --type ts "x"` | `get` | `get { target: "**/*.ts :: §line[text~=\"x\"]" }` | `**/*.ts :: §line[text~="x"]` |
| `grep mode=semantic "parseConfig"` | `get` | (no sugar) | `parseConfig/def→` |
| `ast-grep { pat: "console.log($A)" }` | `get` | (no sugar) | `**/*.ts :: //§call_expression[name=console.log]` |
| `ast-grep { pat, sel }` | `get` | sel is contextual selector | `**/*.ts :: //$pat[.$sel]` |
| `ast-edit { ops: [{pat, out}] }` | `edit` | (none) | `edit { operations: [{ target: "**/*.ts", action: { kind: "findAndReplace", find: pat, content: out } }] }` |
| `edit foo.txt replace pos=10 end=12` | `edit` | (none) | `edit { operations: [{ target: "foo.txt :: §line[10..12]", action: { kind: "replace", content: "…" } }] }` |
| `edit { input: "…patch…" }` | `edit` | (none) | `edit { operations: [{ action: { kind: "patch", diff: "…" } }] }` |
| `write foo.ts content` | `create` | (none) | `create { path: "foo.ts", content: "…" }` |
| `write img.png { kind: "bytes", artifactUri }` | `create` | (none) | `create { path: "img.png", content: { kind: "bytes", artifactUri: "…" } }` |
| `code read { file }` | `get` | `get { target: "file.ts" }` | `file.ts` |
| `code read { file, symbol }` | `get` | `get { target: "file.ts :: Symbol" }` | `file.ts :: Symbol` |
| `code outline { file }` | `get` | `get { target: "file.ts", resolution: 0 }` | `file.ts` |
| `code symbols { query }` | `get` | `get { target: "**::query" }` | `**::query` |
| `code context { symbol }` | `get` | `get { target: "file.ts :: Symbol", edges: true }` | `file.ts :: Symbol` |
| `code impact { symbol }` | `get` | `get { target: "**::Symbol/def→", depth: 3 }` | `**::Symbol/def→` |
| `code flow { symbol }` | `get` | `get { target: "**::Symbol/call→", depth: 3 }` | `**::Symbol/call→` |
| `code deps { file }` | `get` | `get { target: "file.ts/import→" }` | `file.ts/import→` |
| `code save` / `undo` / `redo` / `diff` / `buffers` / `languages` / `index` / `watcherStatus` / `lockStatus` | `manage` | `manage { command: "…", file: "…" }` | — |

Key rules:
- Use `get` for every read, search, listing, or navigation operation.
- Use `edit` for every mutation to an existing file.
- Use `create` for every new file.
- Use `manage` for buffer lifecycle and workspace state.
- Do not use `code` as a prefix for any tool call.
