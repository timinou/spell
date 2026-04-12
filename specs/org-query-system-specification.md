# Pi Org Query System Specification

Complete technical specification of the current TypeScript-based org query system for the planned Rust pi-org-engine replacement.

---

## Executive Summary

The org system has **three query paths**:

1. **Raw org-ql sexp** (`filter.ql`) — Direct pass-through to Emacs org-ql
2. **Keyword query syntax** (`filter.query`) — Parsed TS-side, routes to Emacs if advanced
3. **Structural filter** (state, category, priority, etc.) — Applied TS-side only

The boundary between TS-side and Emacs-side is determined by `requiresEmacs()`: simple predicates (state, tags, priority string match) run locally; advanced predicates (date range, clocked, effort, numeric comparison) transparently route to Emacs.

---

## OrgQueryFilter (TS-Side Structural Filter)

The base interface used for all query operations:

```typescript
export interface OrgQueryFilter {
  /** Filter by state(s) — accepts string or string[]. */
  state?: string | string[];
  
  /** Filter by category name(s) — accepts string or string[]. */
  category?: string | string[];
  
  /** Filter by org dir name(s) — accepts string or string[]. */
  dir?: string | string[];
  
  /** Filter by PRIORITY property value(s), e.g. "#A". */
  priority?: string | string[];
  
  /** Filter by LAYER property value(s). */
  layer?: string | string[];
  
  /** Filter by AGENT property — single string only. */
  agent?: string;
  
  /** Include full body text in results. Default: false. */
  includeBody?: boolean;
  
  /** Filter by heading level. 0 = file-level items only. Omit for all levels. */
  level?: number;
  
  /** Sort key(s). Default: "priority state id". Space-separated for multi-key. */
  sort?: string;
  
  /** Maximum number of items to return. */
  limit?: number;
  
  /** Number of items to skip before returning results. */
  offset?: number;
  
  // Two additional fields for query entry points:
  /** Keyword query syntax string, e.g. "todo:DOING tags:auth priority:>=B" */
  query?: string;
  
  /** Raw org-ql sexp, e.g. "(effort >= \"2h\")" — bypasses all parsing. */
  ql?: string;
}
```

---

## OrgQlFilter (Query-Builder Internal Type)

The parsed representation of a keyword query, used internally by `parseKeywordQuery()` and `buildOrgQlSexp()`.

```typescript
export interface OrgQlFilter {
  // Simple (TS-side evaluable) predicates:
  todo?: string[];          // Parsed from: todo:DOING,REVIEW
  tags?: string[];          // Parsed from: tags:auth,backend
  priority?: {              // Parsed from: priority:>=B or priority:=A
    op: ">=" | "<=" | "=";
    value: string;          // Single letter: A, B, C, or # prefix form
  };
  
  // Property queries (mixed):
  properties?: Array<{      // Parsed from: property:KEY=value
    key: string;
    value: string;
    op?: "=" | ">" | "<";   // Only "=" is TS-evaluable
  }>;
  
  // Advanced (Emacs-only) predicates:
  dateRange?: {             // Parsed implicitly; no keyword syntax (reserved for future)
    from?: string;
    to?: string;
  };
  clocked?: {               // Parsed implicitly; no keyword syntax (reserved for future)
    on?: string;
    from?: string;
  };
  effort?: {                // Parsed implicitly; no keyword syntax (reserved for future)
    op: "<=" | ">=" | "=";
    value: string;
  };
  text?: string;            // Parsed implicitly; no keyword syntax (reserved for future)
  
  // Domain-specific (loop system):
  loopStatus?: string[];       // Parsed from: loop-status:active,waiting
  loopBlocked?: boolean;       // Parsed from: loop-blocked (flag)
  acceptanceFailed?: boolean;  // Parsed from: acceptance-failed (flag)
  dependencyChain?: string;    // Parsed from: dependency-chain:PROJ-042
  loopDepth?: number;         // Parsed from: loop-depth:2
  
  // Logical operators:
  and?: OrgQlFilter[];      // For combining multiple filters
  or?: OrgQlFilter[];       // For combining multiple filters
  not?: OrgQlFilter;        // For negation
}
```

---

## Keyword Query Syntax Specification

Format: **Space-separated tokens**, each of the form `key:value` or bare flag.

### Grammar (ABNF-like)

```
keyword_query = token *(" " token)

token = simple_token | compound_token | flag

simple_token = key ":" value
  key = "todo" | "tags" | "priority" | "property" | "loop-status" 
      | "dependency-chain" | "loop-depth"

compound_token = ("property" ":" key "=" value)  ; e.g. property:ASSIGNED_TO=alice

flag = "loop-blocked" | "acceptance-failed"

value = 1*VCHAR            ; Excluding whitespace

priority_value = [op] priority_letter
  op = ">=" | "<=" | "="
  priority_letter = "A" | "B" | "C" | "#A" | "#B" | "#C"
```

### Examples

```
# Basic state and tags
todo:DOING tags:auth,backend

# Priority with comparison operator
priority:>=B priority:=A

# Multiple priorities (space-separated)
loop-status:active,blocked loop-blocked

# Properties
property:ASSIGNED_TO=alice property:MILESTONE=v2.0

# Domain-specific
dependency-chain:PROJ-042 loop-depth:3

# Combined
todo:DOING,REVIEW tags:critical priority:>=B dependency-chain:PROJ-001 loop-blocked
```

### Parsing Behavior

- **Comma-separated values** within a token are split into arrays (e.g., `tags:a,b` → `["a", "b"]`)
- **No whitespace within a value** — spaces terminate the token
- **Operators in priority** — optional; defaults to `"="` when omitted
- **Boolean flags** — must appear as sole tokens (e.g., `loop-blocked`, not `loop-blocked:true`)
- **Case-sensitive** — keyword keys and flag names are lowercase; values preserve case
- **Unknown tokens** — silently ignored (no error; future-proof)

---

## Filter Predicates and Semantics

### TS-Side Evaluable (applyFilter)

These predicates are evaluated in TypeScript without IPC overhead:

| Predicate | Source | Type | Semantics |
|-----------|--------|------|-----------|
| `state` | OrgQueryFilter | string \| string[] | Exact match on item.state |
| `category` | OrgQueryFilter | string \| string[] | Exact match on item.category |
| `dir` | OrgQueryFilter | string \| string[] | Exact match on item.dir |
| `priority` | OrgQueryFilter | string \| string[] | Exact match on item.properties.PRIORITY |
| `layer` | OrgQueryFilter | string \| string[] | Exact match on item.properties.LAYER |
| `agent` | OrgQueryFilter | string | Exact match on item.properties.AGENT |
| `level` | OrgQueryFilter | number | Exact match on item.level |
| `todo` (from keyword) | OrgQlFilter | string[] | Promoted to `state` in OrgQueryFilter |
| `tags` (from keyword) | OrgQlFilter | string[] | **Not TS-evaluable** — requires Emacs (org-mode tag matching) |
| `text` (from keyword) | OrgQlFilter | string | **Not TS-evaluable** — requires Emacs (regexp matching) |

### Emacs-Side Only (org-ql via Bridge)

These predicates **always** require the Emacs bridge and cannot be evaluated TS-side:

| Predicate | Required | Semantics |
|-----------|----------|-----------|
| `tags` | OrgQlFilter | Tag membership (Emacs org-mode tag syntax) |
| `dateRange` | OrgQlFilter | Timestamp range filtering (Emacs time arithmetic) |
| `clocked` | OrgQlFilter | CLOCK entries (Emacs org-clock support) |
| `effort` | OrgQlFilter | EFFORT property with numeric comparison |
| `text` (regexp) | OrgQlFilter | Regexp search in item text (Emacs regexp engine) |
| `loopStatus` | OrgQlFilter | Custom loop state (Emacs org-ql extension) |
| `loopBlocked` | OrgQlFilter | Custom loop predicate (Emacs org-ql extension) |
| `acceptanceFailed` | OrgQlFilter | Custom acceptance state (Emacs org-ql extension) |
| `dependencyChain` | OrgQlFilter | Custom dependency tracking (Emacs org-ql extension) |
| `loopDepth` | OrgQlFilter | Custom depth tracking (Emacs org-ql extension) |
| `properties` (with op ≠ "=") | OrgQlFilter | Numeric/non-string property comparison |

### Predicates that Affect Routing

The `requiresEmacs(filter: OrgQlFilter): boolean` function returns `true` if ANY of the following are set:

1. `filter.dateRange` — any of `from`, `to`
2. `filter.clocked` — any of `on`, `from`
3. `filter.effort` — any comparison operator
4. `filter.loopStatus`, `filter.loopBlocked`, `filter.acceptanceFailed`, `filter.dependencyChain`, `filter.loopDepth`
5. `filter.properties` with any operator `!== "="`
6. **Recursive:** any child of `filter.and`, `filter.or`, or `filter.not` requires Emacs

---

## Query Execution Flow

### Entry Point: cmdQuery

```typescript
async function cmdQuery(
  ctx: OrgContext,
  filter: OrgQueryFilter & { query?: string; ql?: string; sort?: string; limit?: number; offset?: number },
): Promise<unknown>
```

### Decision Tree

```
cmdQuery receives filter
│
├─ filter.ql (raw sexp) ?
│   └─> [Emacs Path] client.callTool("org-ql-query", { files, query: ql, sort })
│
├─ filter.query (keyword syntax) ?
│   ├─> parseKeywordQuery(filter.query) → OrgQlFilter
│   ├─> Promote qlFilter.todo → filter.state if not already set
│   │
│   └─> requiresEmacs(qlFilter) ?
│       ├─> true  → [Emacs Path] client.callTool("org-ql-query", { files, query: sexp, sort })
│       └─> false → [TS Path] (continue below)
│
└─> [TS Path] (structural filter only)
    ├─> readCategory(...) for each target category → allItems: OrgItem[]
    ├─> applyFilter(allItems, filter) → filtered: OrgItem[]
    ├─> sortItems(filtered, filter.sort) → mutates filtered in place
    └─> paginateResult(filtered, filter.limit, filter.offset) → return
```

### Emacs Bridge Call Protocol

When routing to Emacs, the system calls:

```typescript
client.callTool("org-ql-query", {
  files: string[],           // Expanded .org file paths from target categories
  query: string,             // org-ql sexp (from buildOrgQlSexp or raw filter.ql)
  sort: string,              // Sort key, e.g. "priority todo" or default
})
```

**Response:** Array of OrgItem objects (parsed from Emacs JSON-RPC response).

---

## OrgClient Interface and Emacs Bridge Protocol

### Interface Definition

```typescript
export interface OrgClient {
  /**
   * Call a tool on the Emacs MCP server and return the parsed result.
   *
   * Opens a fresh socat connection per call — simpler than maintaining
   * persistent state and sufficient for low-frequency org operations.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  
  /** No-op for this implementation; kept for API symmetry. */
  close(): Promise<void>;
}
```

### Creation

```typescript
export async function createOrgClient(socketPath: string, socatPath?: string): Promise<OrgClient | null>
```

Returns `null` if socat is unavailable, allowing graceful degradation (though in practice, the system assumes Emacs is always available).

### JSON-RPC Protocol (socat stdio bridge)

**Request Format:**
```json
{
  "jsonrpc": "2.0",
  "id": <number>,
  "method": "tools/call",
  "params": {
    "name": "<tool-name>",
    "arguments": <Record<string, unknown>>
  }
}
```

**Success Response:**
```json
{
  "jsonrpc": "2.0",
  "id": <number>,
  "result": {
    "content": [
      { "type": "text", "text": "<result-json-or-text>" }
    ]
  }
}
```

**Error Response:**
```json
{
  "jsonrpc": "2.0",
  "id": <number>,
  "error": {
    "code": <number>,
    "message": "<error-message>",
    "data": <optional>
  }
}
```

### Transport Mechanism

- **Socket:** Unix domain socket at path configured in Spell config
- **Bridge:** `socat STDIO UNIX-CONNECT:<socketPath>` — spawned fresh per call
- **Timeout:** 30 seconds per call (CALL_TIMEOUT_MS = 30_000)
- **Encoding:** UTF-8 JSON with newline termination
- **Error Handling:** Throws on JSON parse error, MCP error, timeout, or empty response

---

## Sort Keys

Sort is applied **after filtering**.

### Supported Keys

| Key | Semantics |
|-----|-----------|
| `priority` | PRIORITY property order: #A < #B < #C (missing last) |
| `state` or `todo` | TODO state order: INIT < DOING < REVIEW < ITEM < BLOCKED < DONE |
| `id` | Lexicographic by CUSTOM_ID |
| `category` | Lexicographic by category name |

### Default Sort

When `sort` is not specified: **`"priority state id"`** (multi-key: priority first, then state, then ID).

### Multi-Key Example

```typescript
sortItems(items, "priority category id")
// Items sorted by: priority → category → id
```

---

## OrgItem Type (Result Type)

Every query returns an array of items with this structure:

```typescript
export interface OrgItem {
  /** Unique task ID, e.g. "PROJ-042-auth-refactor" */
  id: string;
  
  /** Heading title (without TODO keyword or tags) */
  title: string;
  
  /** TODO state, e.g. "ITEM", "DOING" */
  state: string;
  
  /** Category name, e.g. "projects" */
  category: string;
  
  /** Org dir name, e.g. "tasks" */
  dir: string;
  
  /** Absolute path to the .org file */
  file: string;
  
  /** 1-indexed line number of the heading */
  line: number;
  
  /** Heading level (1 = top-level) */
  level: number;
  
  /** All properties from PROPERTIES drawer (e.g. PRIORITY, LAYER, AGENT) */
  properties: Record<string, string>;
  
  /** Body text below the heading (only if includeBody: true was set) */
  body?: string;
  
  /** Nested sub-items (not populated by query; populated on demand) */
  children?: OrgItem[];
}
```

---

## TODO Keywords and State Transitions

### Valid States

The system recognizes TODO keywords from `OrgConfig.todoKeywords`, typically:

```
INIT → DOING → REVIEW → ITEM → BLOCKED → DONE
```

These are **terminal states** (inactive):
- `DONE`

These are **active states** (in progress):
- `INIT`, `DOING`, `REVIEW`, `ITEM`, `BLOCKED`

**Note:** The exact list is configurable per project; the above is a common example.

---

## Boundary: TS-Side vs Emacs-Side

### TS-Side Responsibilities (fast path)

- `applyFilter()` — direct OrgQueryFilter application
- Filters by: state, category, dir, priority, layer, agent, level
- Sort implementation
- Pagination (limit, offset)
- **No Emacs required**

### Emacs-Side Responsibilities (via MCP bridge)

- Keyword parsing to org-ql sexp (`parseKeywordQuery` + `buildOrgQlSexp`)
- Tag matching (Emacs tag syntax)
- Date range / timestamp arithmetic
- Effort property parsing and numeric comparison
- Regexp search in item text
- Custom loop predicates (loopStatus, loopBlocked, etc.)
- **Requires org-ql library in Emacs**

### Routing Logic (requiresEmacs)

```typescript
function requiresEmacs(filter: OrgQlFilter): boolean {
  if (filter.dateRange || filter.clocked || filter.effort) return true;
  if (filter.loopStatus || filter.loopBlocked || filter.acceptanceFailed 
      || filter.dependencyChain || filter.loopDepth !== undefined) return true;
  if (filter.properties?.some(p => p.op && p.op !== "=")) return true;
  if (filter.and?.some(requiresEmacs)) return true;
  if (filter.or?.some(requiresEmacs)) return true;
  if (filter.not && requiresEmacs(filter.not)) return true;
  return false;
}
```

---

## org-ql S-Expression Format

The `buildOrgQlSexp()` function generates Emacs org-ql queries in s-expression format.

### Generated Predicates

| Filter Field | Generated Sexp |
|--------------|----------------|
| `todo: ["DOING"]` | `(todo "DOING")` |
| `tags: ["auth"]` | `(tags "auth")` |
| `priority: { op: ">=", value: "B" }` | `(priority >= "B")` |
| `properties: [{key: "X", value: "y"}]` | `(property "X" "y")` |
| `dateRange: {from: "2026-01", to: "2026-02"}` | `(ts :from "2026-01" :to "2026-02")` |
| `clocked: {on: "2026-04-11"}` | `(clocked :on "2026-04-11")` |
| `effort: {op: "<=", value: "2h"}` | `(effort <= "2h")` |
| `text: "regex.*pattern"` | `(regexp "regex.*pattern")` |
| `loopStatus: ["active"]` | `(loop-status "active")` |
| `loopBlocked: true` | `(loop-blocked)` |
| `acceptanceFailed: true` | `(acceptance-failed)` |
| `dependencyChain: "PROJ-042"` | `(dependency-chain "PROJ-042")` |
| `loopDepth: 2` | `(loop-depth 2)` |

### Logical Operators

```
filter.and: [f1, f2]  →  (and <f1-sexp> <f2-sexp>)
filter.or: [f1, f2]   →  (or <f1-sexp> <f2-sexp>)
filter.not: f1        →  (not <f1-sexp>)
```

### Composition Rule

- If **exactly 0** parts: return `"(default)"` (matches all)
- If **exactly 1** part: return that part unwrapped
- If **2 or more** parts: wrap in `(and ...)`

---

## Configuration and Detection

### Emacs Detection

```typescript
export async function detectEmacs(configuredPath?: string): Promise<EmacsDetection>
```

Checks:
1. Configured path (from OrgConfig.emacsPath)
2. PATH lookup via Bun.which()
3. Common hardcoded paths (/usr/bin/emacs, /usr/local/bin/emacs, /opt/homebrew/bin/emacs)

Validates:
- **Minimum version:** 29.1 (for org-ql support)
- **socat availability:** Required for JSON-RPC transport

Returns EmacsDetection with:
- `found: boolean` — Emacs binary located
- `path: string | null` — Path to Emacs
- `version: string | null` — Detected version
- `meetsMinimum: boolean` — Version >= 29.1
- `socatFound: boolean` — socat on PATH
- `socatPath: string | null` — Path to socat
- `errors: string[]` — List of problems

---

## Implementation Patterns

### Pattern: Promote Keyword-Parsed Fields to Structural Filter

When `filter.query` is provided, the `todo` field from the parsed OrgQlFilter is promoted to the TS-side `filter.state` for evaluation on the fast path:

```typescript
const qlFilter = parseKeywordQuery(filter.query);
if (qlFilter && qlFilter.todo && !filter.state) {
  filter = { ...filter, state: qlFilter.todo };
}
```

**Rationale:** Avoids sending a full org-ql query to Emacs when only simple state filtering is needed.

### Pattern: Category Resolution

Categories are resolved from config paths at the start of cmdQuery:

```typescript
const categories = resolveCategories(ctx.config, ctx.projectRoot);
const targetCats = filter.category
  ? categories.filter(c => 
      cats.includes(c.name) || cats.includes(c.prefix)
    )
  : categories;
```

Allows filtering by **logical name** (e.g., "projects") or **prefix** (e.g., "PROJ").

### Pattern: Pagination

Applied **after** filtering and sorting:

```typescript
function paginateResult(
  items: unknown[],
  totalBeforePagination: number,
  limit?: number,
  offset?: number,
): { items: unknown[]; total: number }
```

Returns both the sliced items and the **total count before pagination** (for cursor-based pagination UI).

---

## Error Handling

### TS-Side Errors

- Syntax error in keyword query → **silently ignored** (unknown tokens skip)
- Category not found → **returns empty** (not an error)
- Missing includeBody → **defaults to false**

### Emacs-Side Errors

- org-ql sexp syntax error → **JSON-RPC error** thrown
- Emacs tool call timeout → **throws after 30s**
- socat unavailable → **logs warning, returns null from createOrgClient**
- Empty Emacs response → **throws**

### Caller Responsibility

Callers **must** check for error objects in responses (e.g., `{ error: true, code: "NOT_FOUND", message: "..." }`).

---

## Rust Implementation Targets (For pi-org-engine)

Based on this specification, a Rust replacement must:

1. **Preserve the OrgQueryFilter interface** — all structural filter fields must be identical
2. **Implement applyFilter()** — TS-side filter logic (state, category, etc.)
3. **Implement sortItems()** — multi-key sort by priority, state, id, category
4. **Parse keyword query syntax** — fully as specified above
5. **Implement requiresEmacs()** — routing logic to Emacs or local evaluation
6. **Implement buildOrgQlSexp()** — s-expression generation (may delegate to Emacs)
7. **Maintain OrgClient interface** — JSON-RPC over socat
8. **Support pagination** — limit/offset with total count
9. **Preserve TODO keyword and state order** — INIT < DOING < REVIEW < ITEM < BLOCKED < DONE
10. **Support sort keys** — priority, state, id, category

### Phase 1: Replace applyFilter + sortItems (TS-side path)

- Implement Rust filter logic for structural fields
- Load OrgItem from JSON or org-parse output
- Return filtered/sorted results

### Phase 2: Replace parseKeywordQuery + buildOrgQlSexp

- Parse keyword syntax to internal filter representation
- Generate org-ql s-expressions (or delegate generation)
- Route via requiresEmacs

### Phase 3: Replace Emacs Bridge

- Maintain socat JSON-RPC protocol or upgrade to direct Elisp IPC
- Call org-ql from Rust-side (if org library available)
- Else: keep Emacs as backend query engine

---

## Open Questions for Implementation

1. **Tags support in Rust:** Will org-ql be available? Or parse tags from org files locally?
2. **Effort parsing:** Can numeric effort comparison be done without Emacs?
3. **Date arithmetic:** Which Rust crate (chrono? time?) for date range filtering?
4. **Regexp matching:** Standard regex or Emacs-compatible syntax required?
5. **Loop predicates:** Are these domain-specific extensions? Will they be ported?
6. **Sorting stability:** Must maintain multi-key sort with stable ordering across equals?

---

**Document Version:** 1.0  
**Generated:** 2026-04-11  
**Scope:** Full org query system analysis for Rust replacement planning
