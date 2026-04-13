Creates or overwrites a file.

<conditions>
Use for new files when creation is explicitly required, or when replacing an entire unsupported plain-text file is simpler than editing.
</conditions>

<critical>
- Use `code edit { file, operation: "create", content: ["..."] }` for any code-supported file (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.rs`, `.py`, `.pyi`, `.typ`, `.md`, `.mdx`, `.markdown`, `.org`, `.ex`, `.exs`)
- Prefer Edit for existing non-code files
- Do not create documentation files unless explicitly requested
- Do not use emojis unless requested
</critical>

<anti-patterns>
- Do not use Write for incremental source-file edits; if `code edit` supports the file, use `code edit` instead
</anti-patterns>