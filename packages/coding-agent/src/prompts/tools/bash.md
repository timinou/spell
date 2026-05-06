Executes bash commands for terminal operations like git, bun, cargo, python.

{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you do not need immediate output.
- Use `get jobs://` for background job state; use `await` when you need to block until completion.
{{/if}}
- Default spill policy is artifact-first: broad stdout/stderr spills quickly, transcript/log spelunking stays summary-first by default, then follow-up analysis should get the emitted `artifact://…` output.
- Explicit non-zero `head`/`tail` opts into bounded raw output for that call only; `head: 0` and `tail: 0` do **not** opt in.
- Use `lenientSpill: true` only when one bash call truly needs the legacy wider inline tail; it applies to that call only and emits a warning.

<critical>
You **MUST** use specialized tools instead of bash for all file operations.

|Instead of (WRONG)|Use (CORRECT)|
|---|---|
|`cat file`, `head -n N file`|`get { target: "file:N" }` (head N) or `get { target: "file:-N" }` (tail N)|
|`cat -n file \|sed -n '50,150p'`|`get { target: "file:50-150" }`|
|`grep -A 20 'pat' file`|`get { target: "file::§line[text~=\"pat\"]" }`|
|`grep -rn 'pat' dir/`|`get { target: "dir/**/*.ts::§line[text~=\"pat\"]" }`|
|`rg 'pattern' dir/`|`get { target: "dir/**/*.ts::§line[text~=\"pattern\"]" }`|
|`find dir -name '*.ts'`|`get { target: "dir/**/*.ts" }`|
|`ls dir/`|`get { target: "dir/" }`|
|`cat <<'EOF' > file`|`create { path: "file", content: "…" }`|
|`sed -i 's/old/new/' file`|`edit { operations: [{ target: "file", action: { kind: "findAndReplace", find: "old", content: "new" } }] }`|
- You **MUST** use `get` for structural code search instead of bash `grep`/`awk`/`perl` pipelines.
- You **MUST** use `edit` for structural rewrites instead of bash `sed`/`awk`/`perl` pipelines.
- You **MUST NOT** use Bash for get, edit, or create when specialized tools exist.
- You **MUST NOT** use `2>&1` or `2>/dev/null`; stdout and stderr are already merged.
- You **MUST NOT** use `| head -n 50` or `| tail -n 100`; use `head` and `tail` parameters instead.
</critical>

Returns the output and an exit code from command execution.
- If output is truncated, full output can be retrieved from a session-scoped artifact URI and inspected with `get` or a targeted follow-up bash command.
- Exit codes shown on non-zero exit.