Performs fuzzy string replacements in files.

<instruction>
- Use the smallest edit that uniquely identifies the change
- If `old_text` is not unique, expand context or set `all: true`
- Prefer editing existing files
</instruction>

<output>
Returns success or failure; failures report missing text or ambiguous matches.
</output>

<critical>
- Read the file at least once before editing
</critical>

<bash-alternatives>
Use Replace for content-addressed changes. Use bash when position or pattern identifies what to change.
</bash-alternatives>
