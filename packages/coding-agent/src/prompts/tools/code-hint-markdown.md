Markdown-specific code operations:
- Section headings are declarations: `symbol: "Installation"` targets that section.
- Nested sections use dotted symbols: `symbol: "Installation.Prerequisites"`.
- `operation: "promote"` shifts a section subtree up one heading level.
- `operation: "demote"` shifts a section subtree down one heading level.
- `operation: "replace-code-block"` replaces a fenced code block within a section by `index` or `language`.
- `operation: "replace-body"` replaces section content while keeping the heading.
- `read` at resolution 2 shows section content summaries and drill-in hints.