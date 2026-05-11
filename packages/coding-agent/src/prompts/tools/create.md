Create a new file with text, bytes from an artifact URI, or base64-encoded content.

<instruction>
- `path` is the file path. Relative paths resolve against the **session cwd**, NOT against the project / git root.
  - If a spec or AGENTS.md addresses files as `apps/foo/lib/...` from the monorepo root and the session cwd is `apps/foo`, both forms work — `lib/...` is preferred; `apps/foo/lib/...` is auto-coalesced (duplicated cwd-tail stripped) with a `⚠` warning so you can pass the cleaner form next call.
  - Auto-coalesce is suppressed when the literal nested location already exists on disk; the tool writes there and notes "Kept literal interpretation".
  - Degenerate case (path equals the cwd-tail exactly, e.g. `apps/foo`) returns `cwd_prefix_duplication` as a hard error.
  - Use an absolute path when you want to bypass cwd resolution entirely.
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
- Returns success with relative-to-cwd path, byte count, AND the absolute resolved path on a second line. Inspect the second line to confirm the file landed where you expected.
- When the path triggered cwd-prefix auto-coalesce or kept-nested, a third line begins with `⚠` and explains what was decided — you **MUST** use the cleaner form on the next call.
- On error, returns diagnostic with reason (`FileExists`, `WriteShrink`, `ParseRegression`, `SandboxViolation`, `cwd_prefix_duplication`).
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
