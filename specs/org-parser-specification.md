# Org Parser Specification

## Complete OrgItem Type Definition

```typescript
export interface OrgItem {
  /** Unique task ID (e.g. "PROJ-042-auth-refactor"). Derived from CUSTOM_ID property. */
  id: string;

  /** Heading title (without TODO keyword or tags). */
  title: string;

  /** TODO state (e.g. "ITEM", "DOING", "BLOCKED", etc.). */
  state: string;

  /** Category this item belongs to (logical name, e.g. "projects"). */
  category: string;

  /** Org dir this item belongs to (logical name, e.g. "tasks"). */
  dir: string;

  /** Absolute path to the .org file containing this item. */
  file: string;

  /** 1-indexed line number of the heading or file start. */
  line: number;

  /** Heading level: 0 = file-level item, 1+ = heading-level items. */
  level: number;

  /** All properties extracted from PROPERTIES drawer or file-level #+KEY: lines. */
  properties: Record<string, string>;

  /** Body text below the heading (excluding property drawer). Optional, only when includeBody=true. */
  body?: string;

  /** Nested sub-items (populated when requested). */
  children?: OrgItem[];
}
```

---

## Two Item Formats

### 1. File-Level Items (level = 0)

**Recognition**: File contains a `#+CUSTOM_ID:` line in its frontmatter.

**Structure**:
```org
#+TITLE: My Document Title
#+STATE: DOING
#+CUSTOM_ID: PROJ-001
#+SESSION_ID: abc123def
#+TRANSCRIPT_PATH: [[file:/path/to/transcript.jsonl]]
#+PRIORITY: #A
#+EFFORT: 4h
#+LAYER: backend

Body content starts here (free-form text, headings, code blocks, etc.)
Can span multiple paragraphs and sections.
```

**Parser Behavior**:
- Extracts all `#+KEY: value` lines at the file's top
- Stores extracted values in `properties` dict (keys uppercase)
- `TITLE` → `title` field
- `STATE` → `state` field (validated against todo keywords)
- `CUSTOM_ID` → `id` field
- All other `#+KEY` values → `properties[KEY]`
- Body is everything after the frontmatter block and blank lines
- File becomes item with `level: 0`
- Heading-level TODO items within the file become child items (tracked via childIndices)

**File-Level Detection**: Parser returns `null` from `parseFileFrontmatter()` if no `#+CUSTOM_ID:` line exists. File is not treated as a file-level item in that case.

---

### 2. Heading-Level Items

**Recognition**: Heading line starting with `*` and either:
- Contains a TODO keyword at the start of the title (after the stars), OR
- Contains a PROPERTIES drawer with a `CUSTOM_ID` property

**Structure**:
```org
* DOING Task Title
:PROPERTIES:
:CUSTOM_ID: PROJ-042-auth-refactor
:PRIORITY: #A
:EFFORT: 3h
:LAYER: backend
:DEPENDS: PROJ-041
:BLOCKS: PROJ-043
:AGENT: task
:END:

Body text starts after :END: line.
Can include paragraphs, lists, code blocks, etc.
Continues until the next heading at same or higher level.
```

**Heading Line Parse**:
- Format: `*+ [TODO-KEYWORD] Title Text`
- Level determined by count of `*` characters
- If space-separated word after stars is in `todoKeywords` set → becomes `state`
- Remaining text becomes `title`
- Non-TODO headings have `state: null`

**PROPERTIES Drawer Parse**:
- Must immediately follow heading line (with optional blank lines in between)
- Format: `:KEY: value` pairs between `:PROPERTIES:` and `:END:`
- Each property stored in `properties` record (keys case-preserved as-is, typically uppercase)
- Property order in drawer is not significant

**Body Collection**:
- Starts after `:END:` line (skipped)
- Ends at next heading (any level) or EOF
- Trailing blank lines trimmed

**Item Recognition**:
- Included in items list if `state !== null` OR `properties.CUSTOM_ID` is defined
- Sub-outline headings (e.g., structural outline without TODO) included only if they have `CUSTOM_ID`

---

## Complete List of Extracted Fields

### Core Fields (All Items)

| Field | Source | Format | Required |
|-------|--------|--------|----------|
| `id` | `CUSTOM_ID` property | `PREFIX-NNN` or `PREFIX-NNN-slug` or `PREFIX-NNN::sub-slug` | YES* |
| `title` | File: `#+TITLE:` or Heading: text after state | string | YES |
| `state` | File: `#+STATE:` or Heading: TODO keyword | enum (INIT, ITEM, DOING, REVIEW, DONE, BLOCKED) | YES (defaults to empty) |
| `level` | File: always 0 or Heading: count of `*` | 0 = file, 1+ = heading | YES |
| `category` | Configuration (passed to parser) | logical category name | YES |
| `dir` | Configuration (passed to parser) | logical dir name | YES |
| `file` | Configuration (passed to parser) | absolute file path | YES |
| `line` | Parser | 1-indexed line number | YES |

*Required per validation rules but can be empty string in OrgItem

### Validation-Checked Properties

| Property | Validation | Format | Level |
|----------|-----------|--------|-------|
| `CUSTOM_ID` | REQUIRED | `^[A-Z]+-\d+(-[a-z0-9-]+)?(::[a-z0-9-]+)?$` | Error |
| `PRIORITY` | REQUIRED | `^#[ABC]$` (e.g., `#A`, `#B`, `#C`) | Error |
| `EFFORT` | REQUIRED | `^[0-9]+[hm]$` (e.g., `2h`, `30m`) | Error |
| `DEPENDS` | RECOMMENDED | space-separated CUSTOM_IDs | Warning |
| `BLOCKS` | RECOMMENDED | space-separated CUSTOM_IDs | Warning |
| `FILES` | RECOMMENDED | file paths or links | Warning |
| `TEST_PLAN` | RECOMMENDED | free-form | Warning |
| `LAYER` | RECOMMENDED | enum (backend, frontend, data, prompt, infra, test, docs) | Warning |
| `BLAST_RADIUS` | OPTIONAL | free-form | Info |
| `FEATURE_FLAG` | OPTIONAL | free-form | Info |
| `RESEARCH_REF` | OPTIONAL | free-form | Info |
| `AGENT` | OPTIONAL | string (agent name) | Info |

### Session Metadata (File-Level Only)

When a file is created with `OrgSessionContext`, these frontmatter lines are written:

| Field | Source | Format |
|-------|--------|--------|
| `SESSION_ID` | `sessionId` param | string |
| `TRANSCRIPT_PATH` | `transcriptPath` param | org-mode file link `[[file:...]]` |

Corresponding heading is appended:
```org
* Initial Message

<initialMessage text>
```

---

## Property Sources in Org Syntax

### File-Level Syntax (`#+KEY: value`)

```org
#+TITLE: Document Title
#+STATE: DOING
#+CUSTOM_ID: PROJ-001
#+PRIORITY: #A
#+EFFORT: 4h
#+LAYER: backend
#+DEPENDS: PLAN-001 PLAN-002
#+BLOCKS: PROJ-002
#+AGENT: task
#+RESEARCH_REF: https://...
#+FEATURE_FLAG: new-auth-flow
```

Parsing:
- One per line at file start
- Key extracted via `/^#\+([A-Za-z_]+):\s*(.*)$/`
- Key converted to UPPERCASE
- Value is everything after `: ` (trimmed)

### Heading-Level Syntax (`:PROPERTY: value` in `:PROPERTIES:` drawer)

```org
* DOING Task Title
:PROPERTIES:
:CUSTOM_ID: PROJ-042-auth-refactor
:PRIORITY: #A
:EFFORT: 3h
:LAYER: backend
:DEPENDS: PROJ-040 PROJ-041
:BLOCKS: PROJ-043 PROJ-044
:AGENT: task
:RESEARCH_REF: https://...
:FEATURE_FLAG: flag-name
:TEST_PLAN: <test description>
:FILES: src/auth.ts, src/tokens.ts
:BLAST_RADIUS: Medium (affects session auth)
:END:
```

Parsing:
- Lines between `:PROPERTIES:` and `:END:`
- Each line matches `/^\s*:([^:]+):\s*(.*)$/`
- Property name extracted and trimmed
- Value is everything after `: ` (trimmed)
- Case preserved (typically UPPERCASE by convention)

---

## Edge Cases and Special Handling

### 1. Escaped Content in Properties

**Current behavior**: No unescaping. Raw values stored as-is.

**Org-parse module** (in `org-parse.ts`) has helpers for LLM-generated content:
- `unescapeJsonArtifacts(s)`: Handles `\uXXXX` unicode escapes and `\"` quotes
- Used when org content is generated by LLMs

**Example**:
```typescript
const org = 'Body: "He said \\"hello\\""';
const unescaped = unescapeJsonArtifacts(org);
// Result: Body: "He said "hello""
```

### 2. Multi-Line Properties

**File-level**: Each property must be on one line. No continuation support.

**Heading-level**: Each `:KEY: value` pair on single line. No multi-line properties in standard org.

**Workaround**: Use `\n` escapes or store structured data (JSON, YAML) in the value:
```org
:DEPENDS: PROJ-040 PROJ-041 PROJ-042
:FILES: src/auth.ts, src/tokens.ts, src/session.ts
```

### 3. Body Line Trimming

Both file-level and heading-level bodies have trailing blank lines removed:
```typescript
while (item.bodyLines.length > 0 && item.bodyLines[item.bodyLines.length - 1].trim() === "") {
  item.bodyLines.pop();
}
```

### 4. Body Collection Boundaries

**Heading-level**: Body ends at the next heading (any level), not just equal/higher levels.

```org
* DOING Parent Task
:PROPERTIES:
:CUSTOM_ID: PROJ-001
:END:

This is the body of PROJ-001

** DOING Child Sub-Task  <-- This is a separate item, NOT part of parent body
:PROPERTIES:
:CUSTOM_ID: PROJ-001-01
:END:

Child body starts here
```

Parser creates two separate items: parent (level 1) and child (level 2). Child is linked via `childIndices`.

### 5. Blank Line Handling in Frontmatter

File-level parser skips blank lines between frontmatter and body:
```typescript
while (i < lines.length && lines[i].trim() === "") i++;
```

### 6. TODO Keyword Validation

Only recognized keywords become `state`. Unknown words are treated as part of the title:

```org
* UNKNOWN Task Title  <-- UNKNOWN not in todoKeywords set
```

Parser: `state = null`, `title = "UNKNOWN Task Title"`

### 7. Property Drawer Requirements

**Heading-level**: PROPERTIES drawer is optional.
- If missing, item has empty `properties` record
- Item still included if `state !== null` OR `CUSTOM_ID` defined elsewhere (file-level)

**File-level**: All properties in `#+KEY: value` format, never in a drawer.

### 8. Hierarchy via childIndices

Parser maintains a stack-based hierarchy:
- File-level item (if exists) becomes parent for top-level headings
- Each heading's level determines nesting
- Parent items have `childIndices: number[]` (array of indices into the flat items list)
- Callers reconstruct tree structure from childIndices

```typescript
interface ParsedItem {
  level: number;
  state: string | null;
  title: string;
  lineNum: number;
  properties: Record<string, string>;
  bodyLines: string[];
  childIndices: number[];  // <-- indices into items array
}
```

### 9. Item Inclusion Rules

An item is included in the items array if:

```typescript
const isItem = heading.state !== null || item.properties.CUSTOM_ID !== undefined;
```

Examples:
- `* DOING Task Title` → Included (state is DOING)
- `* Structural Heading` → **Excluded** (no state, no CUSTOM_ID)
- `* Structural Heading` with `:CUSTOM_ID: PROJ-001` → Included (has CUSTOM_ID)

### 10. Non-Task Headings

Headings without TODO state and without CUSTOM_ID affect the hierarchy stack but don't become items:

```typescript
} else {
  // Non-task, non-identified heading: still affects the stack for hierarchy
  while (stack.length > 0 && stack[stack.length - 1].item.level >= heading.level) {
    stack.pop();
  }
}
```

This ensures that subsequent task headings have correct parent/child relationships even if structural headings are interspersed.

---

## Sort and Filter Support

### Sort Keys

Implemented via `compareByKey()` function:

| Key | Order | Missing Behavior |
|-----|-------|------------------|
| `priority` | `#A` < `#B` < `#C` | Treated as 99 (last) |
| `state` / `todo` | INIT → ITEM → DOING → REVIEW → BLOCKED → DONE | Unknown states treated as 99 |
| `id` | Lexicographic | Compared as strings |
| `category` | Lexicographic | Compared as strings |

**Default sort** (if none specified): `priority state id`

### Filter Keys

Supported in `OrgQueryFilter`:

| Filter | Field | Value Type |
|--------|-------|-----------|
| `state` | `state` | string or string[] |
| `category` | `category` | string or string[] |
| `dir` | `dir` | string or string[] |
| `priority` | `properties.PRIORITY` | string or string[] |
| `layer` | `properties.LAYER` | string or string[] |
| `agent` | `properties.AGENT` | string (singular) |
| `level` | `level` | number |
| `includeBody` | `body` | boolean (whether to populate) |

---

## State Transitions and Semantics

Default TODO keywords (in order of progression):
- `INIT` — Initial state
- `ITEM` — Item created, not started
- `DOING` — In progress
- `REVIEW` — Under review
- `DONE` — Complete (terminal)
- `BLOCKED` — Stuck (blocking state)

**State Categories** (from `schema/defaults.ts`):
- **Active States**: INIT, DOING, REVIEW
- **Blocked States**: BLOCKED
- **Terminal States**: DONE

**Allowed Transitions**:
```typescript
INIT → DOING, REVIEW, BLOCKED
ITEM → DOING, BLOCKED
DOING → REVIEW, BLOCKED, DONE
REVIEW → DOING, DONE, BLOCKED
BLOCKED → INIT, ITEM, DOING
DONE → (none — terminal)
```

---

## Validation Rules Summary

### Required Properties (ERROR if missing)
- `CUSTOM_ID` — Format: `PREFIX-NNN[-slug][::sub-slug]`
- `PRIORITY` — Format: `#A`, `#B`, or `#C`
- `EFFORT` — Format: `\d+[hm]` (e.g., `2h`, `30m`)

### Recommended Properties (WARNING if missing)
- `DEPENDS` — Space-separated CUSTOM_IDs of blockers
- `BLOCKS` — Space-separated CUSTOM_IDs of blocked items
- `FILES` — File paths related to this task
- `TEST_PLAN` — Testing strategy
- `LAYER` — One of: backend, frontend, data, prompt, infra, test, docs

### Optional Properties (INFO if missing)
- `BLAST_RADIUS` — Scope of impact
- `FEATURE_FLAG` — Feature flag name if applicable
- `RESEARCH_REF` — Research or reference links
- `AGENT` — Agent responsible for task

---

## Parser Implementation Details

### Line-by-Line State Machine

The parser uses a stateful scan (no regex backtracking):
1. **Phase 1**: Try to parse file-level frontmatter (`parseFileFrontmatter`)
2. **Phase 2**: Scan remaining lines for headings (`parseHeadingLine`)
3. **Phase 3**: For each heading, immediately parse PROPERTIES drawer
4. **Phase 4**: Collect body lines until next heading
5. **Phase 5**: Maintain hierarchy stack for childIndices

### Performance Characteristics

- **Single pass** over file content (split into lines)
- **O(n)** for n lines in file
- **No backtracking**: each line examined once
- **Memory**: Stores all lines, creates ParsedItem per task

### Uniorg Integration

The `org-parse.ts` module wraps `uniorg-parse/lib/parser` for AST-based parsing:

**Exported Functions**:
- `orgToMarkdown(org: string): string` — Convert org to CommonMark
- `orgToPlainText(org: string): string` — Extract plain text (no markup)
- `extractOrgKeywords(org: string): Record<string, string>` — Extract `#+KEYWORD` lines
- `parseOrgHeadings(org: string): OrgHeading[]` — Full heading tree with properties

**OrgHeading Type**:
```typescript
interface OrgHeading {
  level: number;
  title: string;
  tags: string[];  // Org tags (e.g., #tag1 #tag2)
  properties: Record<string, string>;
  body: string;
  children: OrgHeading[];  // Nested headings
}
```

---

## Summary: From Rust Implementation Perspective

When implementing a Rust `pi-org-engine`, ensure:

1. **File vs. Heading Detection**: Check for `CUSTOM_ID` in frontmatter to identify file-level items
2. **Property Extraction**: Parse `#+KEY: value` (file-level) and `:KEY: value` (heading-level) separately
3. **State Validation**: Validate against todo-keywords set; unknown states are non-task headings
4. **Body Boundaries**: File-level body ends at EOF or first item heading; heading-level body ends at next heading (any level)
5. **Hierarchy Building**: Use a stack to track parent-child relationships; store childIndices
6. **Line Tracking**: Maintain 1-indexed line numbers for all items
7. **Trailing Whitespace**: Trim trailing blank lines from all bodies
8. **Property Normalization**: Store property keys as uppercase (convention); values as-is
9. **Item Inclusion**: Include only items with `state !== null` OR `CUSTOM_ID` defined
10. **Edge Cases**: Handle blank lines in frontmatter, escaped JSON in LLM output, multi-line bodies, hierarchy with structural headings
