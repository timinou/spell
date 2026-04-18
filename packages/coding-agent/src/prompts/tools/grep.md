Searches files with regex matching built on ripgrep, plus repo-local semantic lookup for symbols and files.

<instruction>
- Default `mode: "auto"` routes simple repo-local symbol/path queries to semantic lookup and regex-oriented requests to raw text search.
- Set `mode: "rawText"` to force ripgrep content search.
- Set `mode: "semantic"` to force repo-local symbol/file lookup through the local code graph.
- Supports full regex syntax in raw-text mode; literal braces need escaping.
- `path` may be a file, directory, glob path, or comma/space-separated path list.
- Filter raw-text searches with `glob` or `type`.
- Respects `.gitignore` by default.
- For cross-line raw-text patterns, set `multiline: true` if needed.
- If the pattern contains a literal `\n`, multiline defaults to true.
- Raw-text hits on supported code files surface exact declaration `targetId` when the match lands on the declaration line, otherwise enclosing `scopeTarget` / `scopeTargetId`.
</instruction>

<output>
- Raw-text output stays CID prefixed: `LINE#ID:content`.
- Semantic output is summarized with model-visible `targetId` lines for one-hop follow-up into `code read` or `code edit`.
</output>

<critical>
- You **MUST** use Grep when searching for repo-local content or symbols/files.
- You **MUST NOT** invoke `grep` or `rg` via Bash.
- If the search is open-ended and needs multiple rounds, you **MUST** use Task tool with explore subagent instead.
</critical>
