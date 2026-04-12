Applies precise file edits by LINE#ID tags from `read` output. Read first, then one `edit` call per file.

<examples>
{{hlinefull  1 "// @ts-ignore"}}
{{hlinefull  2 "const timeout = 5000;"}}
{{hlinefull  3 "const tag = \"DO NOT SHIP\";"}}
{{hlinefull  4 ""}}
{{hlinefull  5 "function alpha() {"}}
{{hlinefull  6 "\tlog();"}}
{{hlinefull  7 "}"}}
{{hlinefull  8 ""}}
{{hlinefull  9 "function beta() {"}}
{{hlinefull 10 "\t// TODO: remove after migration"}}
{{hlinefull 11 "\tlegacy();"}}
{{hlinefull 12 "\ttry {"}}
{{hlinefull 13 "\t\treturn parse(data);"}}
{{hlinefull 14 "\t} catch (err) {"}}
{{hlinefull 15 "\t\tconsole.error(err);"}}
{{hlinefull 16 "\t\treturn null;"}}
{{hlinefull 17 "\t}"}}
{{hlinefull 18 "}"}}
</examples>

<example name="single-line replace">
Change the timeout from `5000` to `30_000`:
```
{
  path: "util.ts",
  edits: [{
    op: "replace",
    pos: {{hlineref 2 "const timeout = 5000;"}},
    lines: ["const timeout = 30_000;"]
  }]
}
```
</example>

<example name="rewrite a block body — shape (a)">
Replace the catch body with smarter error handling. Shape (a): `pos` is the first body line, `end` is the last body line. The catch header and its closer stay untouched.
When changing body content, replace the entire body span.
```
{
  path: "util.ts",
  edits: [{
    op: "replace",
    pos: {{hlineref 15 "\t\tconsole.error(err);"}},
    end: {{hlineref 16 "\t\treturn null;"}},
    lines: [
      "\t\tif (isEnoent(err)) return null;",
      "\t\tthrow err;"
    ]
  }]
}
```
</example>

<example name="replace whole block — shape (b)">
Simplify `beta()` to a one-liner. Shape (b): `pos`=header, `end`=closer, re-emit all in `lines`.
Bad — ending at the inner closer leaves the outer `}` behind.
Good — include the function's own `}` so the old closer is consumed.
```
{
  path: "util.ts",
  edits: [{
    op: "replace",
    pos: {{hlineref 9 "function beta() {"}},
    end: {{hlineref 18 "}"}},
    lines: [
      "function beta() {",
      "\treturn parse(data);",
      "}"
    ]
  }]
}
```
</example>

<critical>
- You **MUST NOT** reformat, reindent, or adjust whitespace; run the formatter instead
- Every tag **MUST** be copied exactly from the most recent `read` output as `N#ID`
- Edit payload: `{ path, edits[] }`; each entry uses `op`, `lines`, optional `pos`/`end`
- For `append`/`prepend`, `lines` **MUST** contain only newly introduced content
- When changing existing code near a block tail or closing delimiter, default to `replace` over the owned span
- When adding a sibling declaration, default to `prepend` on the next sibling declaration
- **Block boundaries travel together.** For a block `{ header / body / closer }`, there are exactly two valid replace shapes: body-only (`pos` first body line, `end` last body line) or whole block (`pos` header, `end` closer, re-emit all three). Never split them; this applies to every block terminator: `}`, `continue`, `break`, `return`, `throw`.
- **Never target shared boundary lines.** Do not use `replace` spans that start, end, or pivot on a line that closes one construct and opens/separates another, such as `},{`, `}),`, `} else {`, or `} catch (err) {`. Move inward to body-only lines, or widen to consume one whole owned construct including its true trailing delimiter.
- **`lines` must not extend past `end`.** Content after `end` survives. If you re-emit lines beyond `end`, they will duplicate.
- `lines` entries **MUST** be literal file content with indentation copied exactly from `read`
- After any successful `edit` call on a file, the next change to that same file **MUST** start with a fresh `read`
- If a local region is already malformed or a prior patch partially landed, replace the full owned block from a stable boundary
</critical>
