# Org Tool Refactor Log

Date: 2026-03-13

## What changed

Four friction points were addressed when the org tool is called by an LLM agent,
plus a structural refactor to clean up accumulated duplication and correctness issues.

### 1. Single-pass mutations

Previously, updating an item's state, title, and body in one `update` call caused
three separate read-parse-write cycles on the same file. Each of the old functions
(`updateItemStateInFile`, `updateItemBodyInFile`, `appendToItemBodyInFile`,
`updateItemTitleInFile`) independently read the file, scanned for the item, mutated,
and wrote it back.

Now `applyItemMutations()` is the single authoritative entry point. It reads the file
once, locates the item once via `locateItem()`, applies all mutations in order
(state, title, body, append), and writes once. The old functions remain as thin
wrappers for backward compatibility.

### 2. Opt-in item echo

After mutating an item, callers previously had to issue a separate `get` call to
verify what was written. Now `update`, `note`, and `set` accept an `includeBody`
parameter. When true, the response includes the full item with body text.

### 3. File path hint

Every `update`/`note`/`set` call used to scan all categories and all .org files to
find an item by CUSTOM_ID. Now these commands accept an optional `file` parameter.
When provided, the tool tries that file first and only falls back to the full scan
if the item isn't found there. Since `create` already returns `file` in its response,
callers can chain: create, grab the file path, then update with the hint.

### 4. Default category for create

`create` no longer requires `category`. When omitted, it defaults to the first
configured category (typically "drafts"), which matches the 90% use case.

## Structural cleanup

### Eliminated 4x frontmatter scan duplication

The old code had four independent functions that each scanned the frontmatter block
with the same `startsWith('#+')` loop and `#+CUSTOM_ID:` check:
`hasFileLevelCustomId`, `findFileLevelBodyRange`, `tryUpdateFileLevelState`,
`tryUpdateFileLevelTitle`. A similar pattern repeated for heading-level items.

All of this is now consolidated into `locateItem()`, which returns a typed context
struct (`FileLevelContext` or `HeadingContext`) with pre-computed line indices. Every
mutation helper takes this context instead of re-scanning.

### Fixed correctness issues

- **Body + append stale indices**: When both `body` and `append` were set, the append
  path read the body range from the already-mutated line array (which body replace had
  just spliced). The indices were stale. Now append re-locates the item context after
  body replace.

- **Null body round-trip fragility**: `updateItemBodyInFile` converted `null` to `""`
  via `??`, then `applyItemMutations` converted `""` back to `null` via `||`. This
  worked by accident through two separate falsy coercions. Now `null` flows through
  directly.

- **ENOENT on file hint**: `applyItemMutations` and `setPropertyInFile` threw when
  given a non-existent file path (e.g., a stale file hint). Now they catch the error
  and return null/false, allowing the caller to fall back to a full scan.

- **Removed unused parameter**: `tryMutateHeadingBody` accepted a `_todoKeywords`
  parameter it never used. Removed.

## Files modified

| File | What changed |
|------|-------------|
| `packages/org/src/types.ts` | Added `ItemMutation` interface |
| `packages/org/src/org-writer.ts` | Rewrote mutation layer: `locateItem()`, context-based helpers, ENOENT handling |
| `packages/org/src/tool.ts` | Rewrote `cmdUpdate`/`cmdNote`/`cmdSet` for single-pass + file hint + includeBody; default category in `cmdCreate` |
| `packages/coding-agent/src/tools/org.ts` | Updated schema descriptions for `file` and `category` params |

## Test results

148 tests, 0 failures, 360 assertions across 11 files (252ms).

32 new tests were added across 2 new files:

### apply-mutations.test.ts (20 tests)

Not found:
  - returns null when file has no matching CUSTOM_ID
  - returns null for heading-level item when CUSTOM_ID not in any drawer

Heading-level single mutations:
  - state change updates keyword in heading line
  - state change with note returns both fields, note appears after :END:
  - title change updates heading text, preserves stars and keyword
  - body replace replaces content between :END: and next heading
  - body clear (null) removes body content
  - append to empty body adds text after :END:
  - append to existing body appends with double newline separator

File-level single mutations:
  - state change updates #+STATE: line
  - title change updates #+TITLE: line
  - body replace replaces content after frontmatter
  - append to existing body in file-level item

Multi-field mutations:
  - state + title + body in one call: all applied, returns all fields
  - body + append in one call: body replaces first, then append applies on top
  - state + append: both applied correctly

Edge cases:
  - empty string body clears body same as null
  - item found but state mutation fails returns empty array, not null
  - multi-item file: only the targeted item is modified
  - note without state change is ignored (not written)

### tool-commands.test.ts (12 tests)

Default category:
  - uses first configured category when category omitted
  - returns error when no categories configured

File hint for update:
  - operates directly on the hinted file, skipping scan
  - falls back to scan when hinted file does not contain the item
  - falls back gracefully when hinted file does not exist

includeBody echo:
  - update with includeBody returns item in response
  - update without includeBody does not return item field
  - note with includeBody returns item in response
  - set with includeBody returns item in response
  - includeBody with bodyless item returns item with undefined body

File hint for note and set:
  - note operates directly on the given file
  - set operates directly on the given file

## Type check

`bun check:ts` passes clean (biome + tsgo, 1168 files checked).
