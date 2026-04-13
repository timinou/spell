Creates or overwrites a file.

<conditions>
Use for new files when creation is explicitly required, or when replacing an entire file is simpler than editing.
</conditions>

<critical>
- Prefer `code edit` for existing source files
- Prefer Edit for existing non-code files
- Do not create documentation files unless explicitly requested
- Do not use emojis unless requested
</critical>

<anti-patterns>
- Do not use Write for incremental source-file edits; if the file already exists and you are changing a declaration, block, or section, use `code edit` instead
</anti-patterns>