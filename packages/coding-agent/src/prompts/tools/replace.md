Performs fuzzy string replacements in files.

<instruction>
- Use the smallest edit that uniquely identifies the change
- If `old_text` is not unique, expand context or set `all: true`
- Prefer editing existing unsupported plain-text files
</instruction>

<output>
Returns success or failure; failures report missing text or ambiguous matches.
</output>

<critical>
- Get the file at least once before editing
- Do not use this tool on any code-supported file (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.rs`, `.py`, `.pyi`, `.typ`, `.md`, `.mdx`, `.markdown`, `.org`, `.ex`, `.exs`); use `edit` instead
</critical>

<bash-alternatives>
Use Replace for content-addressed changes. Use bash when position or pattern identifies what to change.
</bash-alternatives>