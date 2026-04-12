# Markdown Code Engine Integration — Plan Reference

PLAN: `PLAN-217-markdown-code-engine-integration` (24h total)

## Settled Design Decisions

1. **Scope**: Markdown profile + extensible procedure DSL + Typst as proof
2. **Procedure DSL**: Declarative transforms with `Transform::Custom(fn)` escape hatch (documented as DSL improvement flag)
3. **Injection**: Tool result injection on first use per language
4. **Res 2**: Heading tree + content type annotations + symbol paths for drill-in
5. **DeclarationPattern** extended with `NameExtractor` (Field / ChildField / ChildText / Literal) and `BodyExtractor` (None / Field / AfterChild)
6. **ClassLikePattern** extended with body source mode (Field / Direct)
7. **Section = declaration**, nested sections = class-like members. Kind: "section". Name from heading_content. Signature includes markers (`## Installation`)
8. **Frontmatter** (`minus_metadata`/`plus_metadata`) = declaration with `NameExtractor::Literal { name: "frontmatter" }`
9. **Markdown procedures**: promote/demote (declarative — trim/prepend heading markers), replace-code-block (Custom)
10. **Typst procedures**: promote/demote (declarative — trim/prepend `=` markers)
11. **No extract-code-block operation** — res 2 shows metadata with line ranges; normal read at res 3 with offset/limit gets content
12. **tree-sitter-markdown block grammar only** — inline grammar not needed for section-level operations

## Items

| ID | Title | Effort | Wave | Depends |
|----|-------|--------|------|---------|
| FEAT-514 | Extend DeclarationPattern with flexible name/body extraction | 4h | 1 | — |
| FEAT-515 | Add tree-sitter-markdown block grammar | 1h | 1 | — |
| FEAT-522 | Procedure DSL transform layer | 4h | 1 | — |
| FEAT-520 | Markdown language profile | 4h | 2 | FEAT-514, FEAT-515 |
| FEAT-521 | Resolution-aware markdown reading | 3h | 3 | FEAT-520 |
| FEAT-523 | Markdown custom procedures | 3h | 3 | FEAT-520, FEAT-522 |
| FEAT-524 | Typst custom procedures | 2h | 3 | FEAT-522 |
| FEAT-525 | Tool result injection | 2h | 4 | FEAT-520, FEAT-523, FEAT-524 |
| FEAT-526 | Code tool prompt updates | 1h | 5 | FEAT-525 |

## Key Files

### Rust (pi-code-engine)
- `crates/pi-code-engine/src/language/profile.rs` — NameExtractor, BodyExtractor, ClassBodyExtractor
- `crates/pi-code-engine/src/language/mod.rs` — Profile registry, markdown_profile()
- `crates/pi-code-engine/src/language/generated.rs` — Grammar inclusion macros
- `crates/pi-code-engine/src/outline.rs` — Outline extraction, resolution reading
- `crates/pi-code-engine/src/resolve.rs` — Symbol resolution
- `crates/pi-code-engine/src/edit/mod.rs` — Edit operations
- `crates/pi-code-engine/src/procedure/mod.rs` — Procedure DSL + Transform
- `crates/pi-code-engine/build.rs` — Grammar build configuration

### Rust (NAPI bridge)
- `crates/pi-natives/src/code_buffer.rs` — Native command dispatch, procedure fallback

### TypeScript (coding-agent)
- `packages/coding-agent/src/tools/code.ts` — CodeTool class, injection tracking
- `packages/coding-agent/src/prompts/tools/code.md` — Tool prompt
- `packages/coding-agent/src/prompts/tools/code-hint-markdown.md` — Injection content (new)
- `packages/coding-agent/src/prompts/tools/code-hint-typst.md` — Injection content (new)

## tree-sitter-markdown AST Reference

```
document
├─ minus_metadata (YAML frontmatter)
├─ plus_metadata (TOML frontmatter)
└─ section*
   ├─ atx_heading
   │  ├─ atx_h{1-6}_marker ("#", "##", etc.)
   │  └─ heading_content (field) → inline
   ├─ paragraph*
   ├─ fenced_code_block
   │  ├─ fenced_code_block_delimiter
   │  ├─ info_string → language
   │  └─ code_fence_content
   ├─ list, block_quote, pipe_table, html_block...
   └─ section* (nested child sections)
```

## Notes

- FEAT-514 and FEAT-522 are parallel (wave 1) but both modify `LanguageProfile` and profile constructors. If parallel execution causes conflicts, serialize FEAT-514 first.
- `resolve_symbol` only supports 2-level dotting (`Installation.Prerequisites`). Deeper nesting uses line-based access.
- Setext headings not handled initially (ATX only). Can be added later.
