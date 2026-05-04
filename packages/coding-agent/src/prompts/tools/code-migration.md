Migration guide: legacy tools → unified CodePath tools (get / edit / manage / create).

On cutover the seven standalone tools (`find`, `read`, `grep`, `ast-grep`, `ast-edit`, legacy `edit`, `write`) and the legacy `code` subcommand surface are deleted in one cycle. Every behavior they provided is reproduced by `get` / `edit` / `manage` / `create` with a CodePath target.

## Migration table

| Legacy tool | New tool | CodePath syntax |
|-------------|----------|-----------------|
| **Find** | | |
| `find "*.ts"` | `get { target: "**/*.ts" }` | `**/*.ts` |
| `find "*.ts" --hidden=false` | `get { target: "**/*.ts -[¶hidden]" }` | `**/*.ts -[¶hidden]` |
| **Read** | | |
| `read foo.ts` | `get { target: "foo.ts" }` | `foo.ts#raw` |
| `read foo.ts offset=50 limit=100` | `get { target: "foo.ts", offset: 50, head: 100 }` | `foo.ts::§line[50..150]#text` |
| `read dir/` | `get { target: "dir/" }` | `dir/#listing` |
| `ls dir/` | `get { target: "dir/" }` | `dir/` (auto-listing) |
| `ls -R dir/` | `get { target: "dir/", recursive: true }` | `dir/#tree` |
| `ls -L2 dir/` | `get { target: "dir/", depth: 2 }` | `dir/#tree[depth=2]` |
| `read foo.pdf` | `get { target: "foo.pdf" }` | `foo.pdf#text` |
| `read foo.docx` | `get { target: "foo.docx" }` | `foo.docx#text` |
| `read img.png` | `get { target: "img.png" }` | `img.png#image` |
| `read artifact://…/1.txt` | `get { target: "artifact://…/1.txt" }` | `artifact://…/1.txt#raw` |
| `read rule://my-rule` | `get { target: "rule://my-rule" }` | `rule://my-rule#text` |
| **Grep** | | |
| `grep "useState" src/` | `get { target: "src/**::§line[text~=\"useState\"]" }` | `src/**::§line[text~="useState"]` |
| `grep --post 3 "TODO"` | `get { target: "§line[text~=\"TODO\"] >>[0..3]" }` | `§line[text~="TODO"] >>[0..3]` |
| `grep --type ts "x"` | `get { target: "**/*.ts::§line[text~=\"x\"]" }` | `**/*.ts::§line[text~="x"]` |
| `grep mode=semantic "parseConfig"` | (use edge axis) | `parseConfig/def→` |
| **AST Grep** | | |
| `ast-grep { pat: "console.log($A)" }` | (use predicates) | `**/*.ts::§call_expression[name=console.log]` |
| `ast-grep { pat, sel }` | (use has-descendant) | `**/*.ts::§node[.$sel]` |
| **AST Edit** | | |
| `ast-edit { ops: [{pat, out}] }` | `edit { operations: [{ target: "**/*.ts", action: { kind: "findAndReplace", find: pat, content: out } }] }` | — |
| **Edit (legacy hashline)** | | |
| `edit foo.txt replace pos=10 end=12 lines=["…"]` | `edit { operations: [{ target: "foo.txt::§line[10..12]", action: { kind: "replace", content: "…" } }] }` | `foo.txt::§line[10..12]` |
| `edit { input: "--- a/foo.ts\n+++ …" }` | `edit { operations: [{ target: "foo.ts", action: { kind: "patch", diff: "…" } }] }` | — |
| **Write** | | |
| `write foo.ts content` | `create { path: "foo.ts", content: "…" }` | — |
| `write img.png { kind: "bytes", artifactUri }` | `create { path: "img.png", content: { kind: "bytes", artifactUri: "artifact://…" } }` | — |
| **Code (legacy)** | | |
| `code read file.ts` | `get { target: "file.ts" }` | `file.ts` |
| `code edit { targetId: "foo.ts::Bar" }` | `edit { operations: [{ target: "foo.ts::Bar", action: { kind: "…" } }] }` | `foo.ts::Bar` |
| `code outline file.ts` | `get { target: "file.ts", format: "tree" }` | `file.ts#tree` |

## Key differences

- **Unified target syntax**: All tools accept CodePath expressions; no separate `path`/`pattern`/`file` parameters.
- **Projection options**: `head`, `tail`, `offset`, `limit` replace separate pagination params.
- **Format control**: `format` parameter replaces per-tool output modes.
- **Occurrence selectors**: `first`, `last`, `all`, `N` replace ambiguous multi-match behavior.
- **LINE#ID anchors**: Replace legacy hashline `pos`/`end` with stable CID anchors from `get` output.
- **Edge axis**: Replaces semantic grep mode and `context`/`impact`/`flow`/`deps` commands.

Cross-reference: `specs/code-graph/code-path.md` §D, `code-path-extensions.md` §5.
