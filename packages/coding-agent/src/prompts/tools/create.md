Create a new file with text, bytes from an artifact URI, or base64-encoded content.

<instruction>
- `path` is the file path (project-relative or absolute).
- `content` may be:
  - Plain text string.
  - `{ kind: "bytes", artifactUri: "artifact://…" }` to stream bytes from an artifact store entry.
  - `{ kind: "base64", data: "…" }` for base64-encoded content.
- `force=true` overwrites an existing file. Without `force`, the tool rejects with a FileExists error.
- The tool lowers to `edit { action: { kind: "create" } }` internally.
- Use `create` for new files; use `edit` for mutations to existing files.
</instruction>

<output>
- Returns the created path on success.
- If the file exists and `force` is unset, returns a rejection with the path and `exists: true`.
- If the artifact URI cannot be resolved, returns an invalid-artifact-uri error.
</output>

<critical>
- You **MUST** use `create` instead of legacy `write` for new files.
- You **MUST NOT** use `create` to overwrite existing files without explicit `force=true`.
</critical>

<examples>
```
create { path: "src/new-module.ts", content: "export function foo() { return 1; }" }
create { path: "assets/logo.png", content: { kind: "bytes", artifactUri: "artifact://session-id/agent/tool/3.png" } }
create { path: "secrets.json", content: { kind: "base64", data: "ewogICJrZXkiOiAidmFsdWUiCn0=" } }
```
</examples>
