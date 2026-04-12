# Prompt Surface Compression Contract

Governs permanent compression of all prompt .md files in the coding-agent. This is not a style guide — it is a mechanical transform specification.

## Lineage

- **PLAN-181**: "Grammar is predictable; meaning is not. Strip what's predictable."
- **PLAN-209**: "Less content, better placed."
- **PLAN-214**: "The model knows more than we teach it. Teach only what it can't derive."

## Core Principles

1. **Grammar is predictable** — the model reconstructs deleted grammar. Delete articles, filler, hedging, transition phrases.
2. **Schema implies structure** — parameter types, formats, enum values already live in JSON Schema. Do not repeat them in prose.
3. **Code examples are tutorials** — the model knows what `import * as fs from "node:fs"` looks like. State the constraint ("namespace imports only"), delete the example.
4. **Non-obvious exemplar test** — keep an example only if: the model would produce the wrong pattern without it. BAD/GOOD pairs fail this test unless the correct pattern is genuinely surprising.
5. **Handlebars conditionals are structural** — preserve every `{{#if}}`, `{{#unless}}`, `{{#list}}`, `{{else}}`, `{{/if}}` exactly. These are code, not content.
6. **XML tags are semantic** — `<instruction>`, `<critical>`, `<output>`, `<examples>`, `<avoid>`, `<caution>` carry behavioral weight. Preserve tag structure; compress content within.
7. **MUST/MUST NOT survive** — every RFC 2119 keyword constraint transfers to the compressed form.
8. **First sentence is the API** — `compactToolDescription()` extracts the first sentence for specialized tool compaction. It must stand alone truthfully.

## Rules by Category

### AGENTS.md

| Pattern | Action |
|---------|--------|
| BAD/GOOD code pair | Delete. State the constraint in one bullet. |
| "Use X instead of Y" with examples | "X not Y" — one line |
| API tutorial (multi-line code block showing usage) | Delete. Name the API + constraint. |
| Decision table (When X → Use Y) | Keep. Tables are already terse. |
| Multi-sentence rule explanation | One sentence: constraint + rationale fragment. |
| Package/command tables | Keep as-is (already concise). |

Before:
```
**NEVER use named imports from `node:fs`** — always use namespace imports:
// BAD: import { readdir } from "node:fs/promises"
// GOOD: import * as fs from "node:fs/promises"
```

After:
```
- node:fs, node:path, node:os → `import * as` namespace only
```

### Tool Descriptions

| Pattern | Action |
|---------|--------|
| First sentence (capability) | Keep — it's the compacted API |
| `<instruction>` prose paragraphs | → constraint bullet list |
| `<examples>` that teach JSON format | Delete (schema-implied) |
| `<examples>` with non-obvious patterns | Keep (exemplar test passed) |
| `<output>` multi-sentence | → one line |
| `<critical>` prose | → MUST/MUST NOT bullet list |
| `<avoid>` prose | → one-line anti-pattern list |
| `<caution>` prose | → one-line constraint |
| Parameter descriptions duplicating schema | Delete |

Exemplar survival criteria for tool examples:
- Does the example show a structural pattern the model would get wrong? (contextual `sel` mode in ast-grep: keep)
- Does the example show a non-obvious argument combination? (block boundary shapes in hashline: keep)
- Does the example only show "how to call this tool with basic args"? (delete)

### Plan-Mode Overlays

| Pattern | Action |
|---------|--------|
| Phase description paragraph | → one line: "Phase: purpose — what agent does" |
| Duplicated constraint blocks across conditional branches | Emit once after branches close |
| Process manual prose | → decision table or constraint list |
| Multi-sentence bullet points | → one sentence each |
| Example flows | Keep 1 compressed structural example max |

### Agent/Subagent Prompts

| Pattern | Action |
|---------|--------|
| Agent frontmatter (YAML) | Preserve exactly |
| Role description paragraph | → one sentence capability |
| Instruction paragraphs | → constraint list |
| Embedded examples | Apply non-obvious exemplar test |

### Compaction/Memory Templates

| Pattern | Action |
|---------|--------|
| JSON schema definitions | Preserve exactly |
| Output format specifications | Preserve exactly |
| Prose framing around schemas | Compress: remove filler, keep instruction |

## Validation

1. **Semantic anchors**: key constraint strings must survive (grep-verifiable)
2. **Handlebars integrity**: every conditional block preserved exactly
3. **First-sentence API**: each tool file's first sentence is a truthful standalone description
4. **Word count targets**: measured before/after per category
5. **Test suites**: all existing prompt tests must pass with updated assertions

## Targets

| Category | Before (words) | Target (words) | Reduction |
|----------|---------------|----------------|-----------|
| AGENTS.md | 2,961 | <1,500 | ~50% |
| Tool descriptions (41 files) | 12,554 | <6,000 | ~52% |
| Plan-mode overlays (3 main) | 4,445 | <2,700 | ~39% |
| System/agent/compaction prompts | ~3,000 | <2,200 | ~27% |
| **Total compressible** | **~23,000** | **~12,400** | **~46%** |
