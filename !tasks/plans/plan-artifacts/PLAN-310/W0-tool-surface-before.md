# W0 Tool Surface — Before Snapshot

Frozen snapshot of the `org` tool surface as of 2026-05-21. Used as the diff anchor for W6's reduced surface.

---

## 1. Current org tool subcommand description

Source: `packages/org/src/tool.ts:1230-1251`

```typescript
description: `Org-mode project management. Subcommands:
  init        Initialize org directories and category subdirs
  create      Create a new task item (ID auto-generated)
  query       List/filter items (state, category, priority, layer, or keyword query)
  get         Get single item by ID with full body
  update      Change state, body, title, or append text (any combo in one call)
  note        Append a dated NOTE entry to an item (no state change)
  set         Set a single PROPERTIES drawer value
  validate    Validate items
  delete       Delete an item file
  validate-plan Validate a plan via injected callback
  dashboard   Project metrics and in-progress/blocked summary
  wave        Next wave of ready items by priority
  graph       Dependency graph
  archive     Archive DONE items
  suboutline-add Append a structured implementation sub-heading to an existing item with auto-prefixed CUSTOM_ID.
  recall      Hybrid recall search across tasks and memory
  remember    Save an episode or concept to memory
  timeline    Show timeline entries for a target
  subgraph    Show neighborhood subgraph around a node
  link        Add a typed edge between two items
`,
```

---

## 2. Subcommand allowlist

Source: `packages/org/src/tool.ts:1253-1278`

```typescript
command: {
    type: "string",
    enum: [
        "init",
        "create",
        "query",
        "get",
        "update",
        "note",
        "set",
        "validate",
        "delete",
        "validate-plan",
        "dashboard",
        "wave",
        "graph",
        "archive",
        "suboutline-add",
        "recall",
        "remember",
        "timeline",
        "subgraph",
        "link",
    ],
},
```

---

## 3. Schemas / shapes per subcommand

### `recall`

Dispatch site (`packages/org/src/tool.ts:1364-1372`):

```typescript
case "recall":
    return cmdRecall(ctx, {
        text: args.text as string | undefined,
        scope: Array.isArray(args.scope) ? (args.scope as string[]) : undefined,
        focus: args.focus as string | undefined,
        graphHops: args.graphHops as number | undefined,
        limit: args.limit as number | undefined,
        includePersonal: args.includePersonal as boolean | undefined,
    });
```

Handler (`packages/org/src/tool.ts:1113-1137`):

```typescript
async function cmdRecall(
    ctx: OrgContext,
    args: {
        text?: string;
        scope?: string[];
        focus?: string;
        graphHops?: number;
        limit?: number;
        includePersonal?: boolean;
    },
): Promise<unknown> {
    const result = executeOrg({
        command: "recall",
        text: args.text,
        scope: args.scope,
        focus: args.focus,
        graphHops: args.graphHops,
        limit: args.limit,
        includePersonal: args.includePersonal,
        repoRoot: ctx.projectRoot,
    });
    if (result.error) throw new Error(String(result.output));
    return result.output;
}
```

**Return shape:** opaque — passes through `executeOrg("recall", …)` output directly.

---

### `remember`

Dispatch site (`packages/org/src/tool.ts:1373-1382`):

```typescript
case "remember":
    return cmdRemember(ctx, {
        kind: args.kind as string,
        summary: args.summary as string,
        involves: Array.isArray(args.involves) ? (args.involves as string[]) : undefined,
        about: Array.isArray(args.about) ? (args.about as string[]) : undefined,
        produced: Array.isArray(args.produced) ? (args.produced as string[]) : undefined,
        distilledFrom: Array.isArray(args.distilledFrom) ? (args.distilledFrom as string[]) : undefined,
        supersedes: Array.isArray(args.supersedes) ? (args.supersedes as string[]) : undefined,
    });
```

Handler (`packages/org/src/tool.ts:1138-1164`):

```typescript
async function cmdRemember(
    ctx: OrgContext,
    args: {
        kind: string;
        summary: string;
        involves?: string[];
        about?: string[];
        produced?: string[];
        distilledFrom?: string[];
        supersedes?: string[];
    },
): Promise<unknown> {
    const result = executeOrg({
        command: "remember",
        kind: args.kind,
        summary: args.summary,
        involves: args.involves,
        about: args.about,
        produced: args.produced,
        distilledFrom: args.distilledFrom,
        supersedes: args.supersedes,
        repoRoot: ctx.projectRoot,
    });
    if (result.error) throw new Error(String(result.output));
    return result.output;
}
```

**Return shape:** opaque — passes through `executeOrg("remember", …)` output directly.

---

### `timeline`

Dispatch site (`packages/org/src/tool.ts:1383-1387`):

```typescript
case "timeline":
    return cmdTimeline(ctx, {
        target: args.target as string,
        kind: args.kind as string | undefined,
    });
```

Handler (`packages/org/src/tool.ts:1165-1180`):

```typescript
async function cmdTimeline(
    ctx: OrgContext,
    args: {
        target: string;
        kind?: string;
    },
): Promise<unknown> {
    const result = executeOrg({
        command: "timeline",
        target: args.target,
        repoRoot: ctx.projectRoot,
    });
    if (result.error) throw new Error(String(result.output));
    return result.output;
}
```

**Return shape:** opaque — passes through `executeOrg("timeline", …)` output directly. (Note: `args.kind` is destructured in the dispatch but **not forwarded** to `executeOrg`.)

---

### `subgraph`

Dispatch site (`packages/org/src/tool.ts:1388-1393`):

```typescript
case "subgraph":
    return cmdSubgraph(ctx, {
        root: args.root as string,
        hops: args.hops as number | undefined,
        kinds: Array.isArray(args.kinds) ? (args.kinds as string[]) : undefined,
    });
```

Handler (`packages/org/src/tool.ts:1181-1199`):

```typescript
async function cmdSubgraph(
    ctx: OrgContext,
    args: {
        root: string;
        hops?: number;
        kinds?: string[];
    },
): Promise<unknown> {
    const result = executeOrg({
        command: "subgraph",
        root: args.root,
        hops: args.hops ?? 1,
        kinds: args.kinds,
        repoRoot: ctx.projectRoot,
    });
    if (result.error) throw new Error(String(result.output));
    return result.output;
}
```

**Return shape:** opaque — passes through `executeOrg("subgraph", …)` output directly.

---

### `link`

Dispatch site (`packages/org/src/tool.ts:1394-1401`):

```typescript
case "link":
    return cmdLink(ctx, {
        from: args.from as string,
        to: args.to as string,
        kind: args.kind as string,
    });
```

Handler (`packages/org/src/tool.ts:1200-1214`):

```typescript
async function cmdLink(
    ctx: OrgContext,
    args: {
        from: string;
        to: string;
        kind: string;
    },
): Promise<unknown> {
    const result = executeOrg({
        command: "link",
        from: args.from,
        to: args.to,
        kind: args.kind,
        repoRoot: ctx.projectRoot,
    });
    if (result.error) throw new Error(String(result.output));
    return result.output;
}
```

**Return shape:** opaque — passes through `executeOrg("link", …)` output directly.

---

## 4. Prompt files referencing these subcommands

Search scope: `packages/coding-agent/src/prompts/` and `packages/coding-agent/src/skills/`  
Search terms: `org recall`, `org remember`, `org timeline`, `org subgraph`, `org link`, `recall_engine`, `RecallQuery`, `RecallHit`

**Results:**

| File | Line | Matched text |
|------|------|--------------|
| `packages/coding-agent/src/prompts/system/eager-todo.md` | 6 | `…gates, org links, blockers…` |
| `packages/coding-agent/src/prompts/system/plan-mode-approved.md` | 113 | `…gates, org links, or a manually curated roster…` |
| `packages/coding-agent/src/prompts/system/plan-mode-approved.md` | 120 | `…pre-structured gates or org links; otherwise omit…` |
| `packages/coding-agent/src/prompts/tools/todo-write.md` | 4 | `…work, add gates or org links, or revise the auto-created plan…` |

No prompt files mention `org recall`, `org remember`, `org timeline`, `org subgraph`, `recall_engine`, `RecallQuery`, or `RecallHit`.  
(Repo-wide grep for `recall_engine`, `RecallQuery`, and `RecallHit` returned zero hits.)

---

## 5. Session-start projection wiring

Source: `packages/coding-agent/src/memories/projection.ts:20-26`

```typescript
export async function renderSessionStartSummary(cwd: string): Promise<string> {
```

Full signature with JSDoc (`packages/coding-agent/src/memories/projection.ts:15-20`):

```typescript
/**
 * Render the session-start memory_summary.md from a recall projection.
 * Writes to `<cwd>/.spell/memory/cache/memory_summary.md` and returns the rendered text.
 */
export async function renderSessionStartSummary(cwd: string): Promise<string> {
```

**Callers (production code):** **Zero.**  
References search (`grep -r "renderSessionStartSummary" packages/coding-agent/src/`) returns only the definition in `projection.ts:20`.  
The only other references are in the test suite (`packages/coding-agent/test/memories/projection.test.ts`).

---

## 6. memory_summary.md generation

All writers identified in `packages/coding-agent/src/memories/`:

### Writer 1 — `renderSessionStartSummary` (projection)

Source: `packages/coding-agent/src/memories/projection.ts:50`

```typescript
await writeFile(path.join(cacheDir, "memory_summary.md"), rendered, "utf8");
```

### Writer 2 — `applyConsolidation`

Source: `packages/coding-agent/src/memories/index.ts:929`

```typescript
await Bun.write(path.join(memoryRoot, "memory_summary.md"), `${consolidated.memorySummary.trim()}\n`);
```

### Deletion path (not a writer, noted for lifecycle completeness)

Source: `packages/coding-agent/src/memories/index.ts:801`

```typescript
await fs.rm(path.join(memoryRoot, "memory_summary.md"), { force: true });
```

---

## 7. MEMORY.md writers

### Writer 1 — `applyConsolidation`

Source: `packages/coding-agent/src/memories/index.ts:928`

```typescript
await Bun.write(path.join(memoryRoot, "MEMORY.md"), `${consolidated.memoryMd.trim()}\n`);
```

### Deletion path

Source: `packages/coding-agent/src/memories/index.ts:800`

```typescript
await fs.rm(path.join(memoryRoot, "MEMORY.md"), { force: true });
```

---

## 8. AGENTS.md / system prompt mentions

### AGENTS.md mentions in the system prompt builder (`packages/coding-agent/src/system-prompt.ts`)

Discovery logic (`packages/coding-agent/src/system-prompt.ts:95-110`):

```typescript
if (depth >= AGENTS_MD_MIN_DEPTH) {
    const hasAgentsMd = entries.some(entry => entry.isFile() && entry.name === "AGENTS.md");
    if (hasAgentsMd) {
        const relPath = normalizePath(path.relative(root, path.join(dir, "AGENTS.md")));
        if (relPath.length > 0) {
            discovered.add(relPath);
        }
        if (discovered.size >= limit) {
            return;
        }
    }
}
```

Type definition (`packages/coding-agent/src/system-prompt.ts:400-415`):

```typescript
/** Pre-computed AGENTS.md search result. */
agentsMdSearch?: AgentsMdSearch;
```

Search wiring (`packages/coding-agent/src/system-prompt.ts:485-515`):

```typescript
raceWithTimeout(
    "AGENTS.md discovery",
    agentsMdSearchPromise,
    {
        scopePath: ".",
        limit: AGENTS_MD_LIMIT,
        pattern: `AGENTS.md depth ${AGENTS_MD_MIN_DEPTH}-${AGENTS_MD_MAX_DEPTH}`,
        files: [],
    },
    SYSTEM_PROMPT_PREP_TIMEOUT_MS,
),
```

Runtime comment (`packages/coding-agent/src/system-prompt.ts:508-514`):

```typescript
// Surface cwd vs git-toplevel asymmetry: when the session cwd is below
// the git working tree, agents that read project-rooted paths from
// AGENTS.md / specs / plan items will silently double-prefix when
// passing them to path-resolving tools (see BUG: cwd_prefix_duplication).
```

### `memory_summary` / `MEMORY.md` mentions in prompt templates

`packages/coding-agent/src/prompts/system/system-prompt.md:131`:

```markdown
- `memory://root` — Project memory summary (`memory_summary.md`)
```

`packages/coding-agent/src/prompts/memories/read-path.md:4-5,11`:

```markdown
1) You **MUST** get `memory://root/memory_summary.md` first.
2) If needed, you **SHOULD** inspect `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md`.
…
{{memory_summary}}
```

`packages/coding-agent/src/prompts/memories/consolidation.md:10,23`:

```markdown
"memory_summary": "string",
…
- memory_summary: compact prompt-time memory guidance.
```

`packages/coding-agent/src/prompts/memories/session-start.md.hbs:1`:

```markdown
{{!-- session-start.md.hbs: deterministic memory_summary projection --}}
```

No mentions of `recall`, `remember`, `timeline`, `subgraph`, or `link` subcommands exist in the system prompt builder or prompt templates.
