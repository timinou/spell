Create a new file with text, bytes from an artifact URI, or base64-encoded content.

<instruction>
- `path` is the file path (relative or absolute).
- `content` accepts three forms:
  - **String**: Direct text content.
  - **Bytes**: `{ kind: "bytes", artifactUri: "artifact://..." }` to copy from an artifact.
  - **Base64**: `{ kind: "base64", data: "..." }` for binary data.
- `force=true` overwrites existing files and bypasses guards.
- Rejected when file exists (unless force); returns `FileExists` diagnostic.
- Write-shrink guard: if new file is suspiciously small compared to similar files in project, returns warning.
- Parse-regression guard: if tree-sitter parse fails where project has parseable files of same type, returns warning.
- Sandbox/mode guard: rejects writes outside project root or to restricted paths (e.g., `.git/`).
</instruction>

<output>
- Returns success with file path and byte count.
- On error, returns diagnostic with reason (`FileExists`, `WriteShrink`, `ParseRegression`, `SandboxViolation`).
</output>

<examples>
```
create { path: "src/new-module.ts", content: "export const foo = 42;" }
create { path: "dist/bundle.js", content: { kind: "bytes", artifactUri: "artifact://abc/output.js" } }
create { path: "img/logo.png", content: { kind: "base64", data: "iVBORw0KG..." } }
create { path: "src/exists.ts", content: "...", force: true }
```
</examples>

<critical>
- You **MUST** use `create` for new files; use `edit` for modifying existing files.
- You **MUST NOT** use `write` (legacy tool) or bash redirection for file creation.
- Set `force=true` only when deliberately overwriting an existing file.
- For new source files in supported languages, prefer `edit` with `kind: "write"` for better integration.
</critical>
