Executes bash commands for terminal operations like git, bun, cargo, python.

{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you do not need immediate output.
- Use `read jobs://` for background job state; use `await` when you need to block until completion.
{{/if}}

<critical>
You **MUST** use specialized tools instead of bash for all file operations.

|Instead of (WRONG)|Use (CORRECT)|
|---|---|
|`cat file`, `head -n N file`|`read(path="file", limit=N)`|
|`cat -n file \|sed -n '50,150p'`|`read(path="file", offset=50, limit=100)`|
|`grep -A 20 'pat' file`|`grep(pattern="pat", path="file", post=20)`|
|`grep -rn 'pat' dir/`|`grep(pattern="pat", path="dir/")`|
|`rg 'pattern' dir/`|`grep(pattern="pattern", path="dir/")`|
|`find dir -name '*.ts'`|`find(pattern="dir/**/*.ts")`|
|`ls dir/`|`read(path="dir/")`|
|`cat <<'EOF' > file`|`write(path="file", content="…")`|
|`sed -i 's/old/new/' file`|`edit(path="file", edits=[…])`|
{{#if hasAstEdit}}|`sed -i 's/oldFn(/newFn(/' src/*.ts`|`ast_edit({ops:[{pat:"oldFn($$$A)", out:"newFn($$$A)"}], path:"src/"})`|{{/if}}
{{#if hasAstGrep}}- You **MUST** use `ast_grep` for structural code search instead of bash `grep`/`awk`/`perl` pipelines{{/if}}
{{#if hasAstEdit}}- You **MUST** use `ast_edit` for structural rewrites instead of bash `sed`/`awk`/`perl` pipelines{{/if}}
- You **MUST NOT** use Bash for read, grep, find, edit, or write when specialized tools exist.
- You **MUST NOT** use `2>&1` or `2>/dev/null`; stdout and stderr are already merged.
- You **MUST NOT** use `| head -n 50` or `| tail -n 100`; use `head` and `tail` parameters instead.
</critical>

Returns the output and an exit code from command execution.
- If output is truncated, full output can be retrieved from a session-scoped artifact URI.
- Exit codes shown on non-zero exit.
