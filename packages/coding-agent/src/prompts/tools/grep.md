Searches files with regex matching built on ripgrep.

<instruction>
- Supports full regex syntax; literal braces need escaping.
- `path` may be a file, directory, glob path, or comma/space-separated path list.
- Filter files with `glob` or `type`.
- Respects `.gitignore` by default.
- For cross-line patterns, set `multiline: true` if needed.
- If the pattern contains a literal `\n`, multiline defaults to true.
</instruction>

<output>
- Text output is CID prefixed: `LINE#ID:content`.
</output>

<critical>
- You **MUST** use Grep when searching for content.
- You **MUST NOT** invoke `grep` or `rg` via Bash.
- If the search is open-ended and needs multiple rounds, you **MUST** use Task tool with explore subagent instead.
</critical>