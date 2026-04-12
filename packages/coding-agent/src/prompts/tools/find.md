Finds files using fast pattern matching.

<instruction>
- Pattern includes the search path.
- You may provide comma/space-separated path lists; each item is searched and results are merged.
- Simple patterns like `*.ts` search recursively from cwd.
- Hidden files are included by default.
- Use multiple searches in parallel when useful.
</instruction>

<output>
- Matching file paths are sorted by modification time; truncated at 1000 entries or 50KB.
</output>

<avoid>
- For open-ended searches requiring multiple rounds of globbing and grepping, you **MUST** use Task tool instead.
</avoid>