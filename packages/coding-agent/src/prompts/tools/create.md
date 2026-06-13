Materialize a new file. ✗ for existing files (use `edit`).

call ::= create { path, content, force? }

content ::=
  string                                       text
  · { kind: "bytes", artifactUri }             from artifact://
  · { kind: "base64", data }                   binary

<rules>
- path resolves vs session cwd; absolute path bypasses resolution
- existing path → FileExists diagnostic (unless `force: true`)
- cwd-tail duplication (e.g. `apps/foo/lib/x` when cwd is `apps/foo`) auto-coalesces or rejects
- parse-regression + write-shrink guards run by default; `force: true` bypasses
- for modifying an existing file: use `edit`, not `create { force: true }`
</rules>