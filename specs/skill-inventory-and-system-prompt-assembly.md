# Complete Skill Inventory & System Prompt Assembly Specification

**Date**: 2026-04-11  
**Scope**: All skills shipped with coding-agent + all system prompt artifacts that reach the LLM  
**Purpose**: Comprehensive inventory of everything assembled into the agent's declaration of being

---

## Executive Summary

The Spell coding-agent system assembles a complete system prompt from multiple artifact sources:

1. **Core system prompt template** (`system-prompt.md`) — identity, behavior, design integrity, contract, procedure
2. **Dynamically loaded skills** — specialized knowledge from 9 installed skill directories
3. **Rules and constraints** — domain-specific rules from `.spell/rules/` or discovered from ancestor dirs
4. **Context files** — project-local AGENTS.md documents, .spell/context files
5. **Tool descriptions** — generated dynamically from available tools
6. **Append prompts** — caveman mode formatting, custom appends
7. **Environment metadata** — workspace, date, cwd, GPU info
8. **MCP discovery summaries** — Claude plugin and MCP server metadata (when enabled)

All of this reaches the model as a **SystemPromptBlock** with stable vs dynamic sections split by `CACHE_BOUNDARY_MARKER`.

---

## I. Installed Skills Inventory

### A. Discovery Architecture

Skills are discovered and loaded via:

```
LoadContext (cwd, home, repoRoot)
  ↓
Discovery Providers: native, claude, codex, gemini, opencode, cursor, windsurf, cline, agents, github
  ↓
scanSkillsFromDir() → SKILL.md or SKILL.org files
  ↓
loadSkills() → filtered, deduplicated, ordered list
  ↓
Rendered into system-prompt.md template as:
   ## {{name}}
   {{description}}
```

**Key paths:**
- User-level: `~/.spell/agent/skills/` (native)
- Project-level: `.spell/skills/` (native)
- Alternate locations: `.claude/skills/`, `.codex/skills/`, `.cursor/skills/`, etc.
- Provider-specific paths in `SOURCE_PATHS` (helpers.ts:17-72)

### B. Currently Installed Skills (`.spell/skills/`)

| # | Name | Path | Lines | Description | Frontmatter |
|---|------|------|-------|---|---|
| 1 | `coding` | `.spell/skills/coding/SKILL.md` | 15 | General coding guidance; design planning with `/design` and `/ultraplan` commands | `name: coding` (no explicit description field) |
| 2 | `canvas` | `.spell/skills/canvas/SKILL.md` | 296 | Rich structured-data display in native QML windows (tables, diffs, trees, markdown, images) | `name: canvas`, `description: "Spawn a native QML canvas..."`, `version: 2.0.0` |
| 3 | `brand-asset-gallery` | `.spell/skills/brand-asset-gallery/SKILL.md` | 142 | Generate and iterate visual brand assets in interactive QML gallery | `name: brand-asset-gallery`, `description: "Generate brand asset variations..."` |
| 4 | `qml-testing` | `.spell/skills/qml-testing/SKILL.md` | 291 | Headless QML integration testing via bridge's DOM introspection | `name: qml-testing`, `description: "Headless QML integration testing..."` |
| 5 | `voice-agent` | `.spell/skills/voice-agent/SKILL.md` | 114 | Live voice transcription with wake-word detection (say "spell" → process command) | `name: voice-agent`, `description: "Voice-to-agent flow..."`, `version: 1.0.0` |
| 6 | `semantic-compression` | `.spell/skills/semantic-compression/SKILL.md` | ~67* | Aggressively remove grammatical scaffolding while preserving meaning | `name: semantic-compression`, `description: "Aggressively remove grammatical..."` |
| 7 | `system-prompts` | `.spell/skills/system-prompts/SKILL.md` | ~643* | Write system prompts, tool docs, agent definitions; research-backed techniques | `name: system-prompts`, `description: "Write system prompts, tool docs..."` |
| 8 | `spell-server-setup` | `.spell/skills/spell-server-setup/SKILL.md` | ~721* | Interactive wizard for bootstrapping .spell/ directory with spell-server config | `name: spell-server-setup`, `description: "Interactive wizard to bootstrap..."`, `version: 1.0.0` |
| 9 | `typst` | `.spell/skills/typst/SKILL.md` | ~403* | Write and compile Typst documents (PDFs, reports, proposals) | `name: typst`, `description: "Write and compile excellent Typst..."`, `globs: ["**/*.typ"]` |

*Line counts marked with `*` are approximate (read only partial file).

### C. Test Fixture Skills (for validation, not shipped)

Located in `packages/coding-agent/test/fixtures/skills/`:
- `consecutive-hyphens/SKILL.md` — validation test
- `invalid-name-chars/SKILL.md` — validation test
- `long-name/SKILL.md` — validation test
- `missing-description/SKILL.md` — validation test
- `name-mismatch/SKILL.md` — validation test
- `nested/child-skill/SKILL.md` — validation test
- `no-frontmatter/SKILL.md` — validation test
- `unknown-field/SKILL.md` — validation test
- `valid-skill/SKILL.md` — canonical valid skill
- `skills-collision/first/calendar/SKILL.md` — name collision test
- `skills-collision/second/calendar/SKILL.md` — name collision test

These are **not** assembled into the agent prompt.

### D. Base vs Optional Skills

**All currently installed skills are optional** — they are loaded conditionally:

```typescript
// extensibility/skills.ts:89-92
if (!enabled) {
    return { skills: [], warnings: [] };
}
```

**Load conditions:**
- `enabled` — overall skills master switch (default: `true`)
- `enablePiUser` — native user-level skills (default: `true`)
- `enablePiProject` — native project-level skills (default: `true`)
- `enableCodexUser`, `enableClaudeUser`, `enableClaudeProject` — for other editor environments
- `ignoredSkills` — glob patterns to skip (default: empty)
- `includeSkills` — glob patterns to include (default: all)
- `disabledExtensions` — explicit skill IDs to skip (prefix: `skill:`)

**There is NO "base skills" concept.** All skills are discovered dynamically and filtered at runtime. Skills cannot be shipped as required; they must all be removable.

---

## II. System Prompt Assembly Pipeline

### A. Entry Point: `buildSystemPrompt()`

**Location**: `packages/coding-agent/src/system-prompt.ts:370-587`

```typescript
async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<SystemPromptBlock[]>
```

**Inputs** (from `options`):
- `settings?: Settings` — caveman mode, thinking level, skill settings
- `customPrompt?: string` — custom system prompt override
- `appendSystemPrompt?: string` — additional text to append
- `tools?: Map<string, AgentTool>` — available tools
- `contextFiles?: Array<{ path, content, depth }>` — pre-loaded context files
- `providedSkills?: Skill[]` — pre-loaded skills (bypasses discovery)
- `rules?: Rule[]` — domain-specific rules
- `cwd?: string` — working directory for discovery
- `skillsSettings?: SkillsSettings` — skill loading config
- Other flags: `eagerTasks`, `autoRosterEnabled`, `mcpDiscoveryMode`, etc.

### B. Parallel Preparation Phase (lines 413-451)

The function spawns **6 parallel tasks** with a 5-second timeout:

1. **System prompt customization** — loaded from `.spell/custom-system-prompt.md` or `.spell/system-prompt.md`
2. **Append system prompt** — from `.spell/append-system-prompt.md`
3. **Context files** — recursively collected from `.spell/context/`
4. **AGENTS.md search** — crawls ancestors (depth 1-4) for AGENTS.md files
5. **Skills loading** — calls `loadSkills()` with discovery and filtering
6. **Caveman prompt template** — if caveman mode active, renders caveman formatting

```typescript
// system-prompt.ts:428-434
return Promise.all([
    resolvePromptInput(customPrompt, "system prompt"),
    resolvePromptInput(appendSystemPrompt, "append system prompt"),
    systemPromptCustomizationPromise,
    contextFilesPromise,
    agentsMdSearchPromise,
    skillsPromise,  // <- Skills discovered here
])
```

### C. Template Rendering

**Template**: `packages/coding-agent/src/prompts/system/system-prompt.md` (379 lines)

**Rendering engine**: `renderPromptTemplate()` (config/prompt-templates.ts)
- Uses Handlebars-like syntax: `{{#if}}`, `{{#each}}`, `{{#list}}`
- Supports conditionals, loops, helpers
- Data object passed with all collected values

**Key template sections:**

1. **Lines 12-35**: Workspace section
   ```handlebars
   <workstation>
   {{#list environment prefix="- " join="\n"}}{{label}}: {{value}}{{/list}}
   </workstation>
   
   {{#if contextFiles.length}}
   <context>
   {{#each contextFiles}}
   <file path="{{path}}">{{content}}</file>
   {{/each}}
   </context>
   {{/if}}
   ```

2. **Lines 37-240**: Identity + behavior + design integrity + contract + procedure (core system prompt)

3. **Lines 170-179**: Skills section
   ```handlebars
   {{#if skills.length}}
   You **MUST** use the following skills, to save you time, when working in their domain:
   {{#each skills}}
   ## {{name}}
   {{description}}
   {{/each}}
   {{/if}}
   ```

4. **Lines 181-188**: Rules section
   ```handlebars
   {{#if rules.length}}
   # Rules
   {{#each rules}}
   ## {{name}} (Domain: {{#list globs join=", "}}{{this}}{{/list}})
   {{description}}
   {{/each}}
   {{/if}}
   ```

5. **Lines 190-240**: Tools section (generated from toolInfo array)

6. **Lines 240+**: MCP Discovery, AGENTS.md search, environment metadata

### D. Data Object Passed to Template

**Location**: `system-prompt.ts:546-571`

```typescript
const data = {
    systemPromptCustomization: string,      // From .spell/custom-system-prompt.md
    customPrompt: string | undefined,       // If custom prompt provided
    appendPrompt: string,                   // Appended text + caveman formatting
    tools: string[],                        // Tool names
    toolInfo: Array<{ name, label, description }>,  // Tool metadata
    repeatToolDescriptions: boolean,        // Whether to repeat tool descs
    environment: Record<string, string>,    // System info (GPU, OS, CPU, etc.)
    contextFiles: Array<{ path, content, depth }>,  // Loaded context files
    agentsMdSearch: { scopePath, limit, pattern, files },  // AGENTS.md discovery
    skills: Skill[],                        // **Filtered skills list**
    rules: Rule[],                          // Domain rules
    date: string,                           // YYYY-MM-DD
    dateTime: string,                       // ISO 8601
    cwd: string,                            // Working directory
    intentTracing: boolean,                 // If intentField provided
    intentField: string,                    // Intent tracing field name
    mcpDiscoveryMode: boolean,              // MCP discovery enabled
    hasMCPDiscoveryServers: boolean,        // If MCP servers found
    mcpDiscoveryServerSummaries: string[],  // MCP server descriptions
    eagerTasks: boolean,                    // Eager task execution flag
    autoRosterEnabled: boolean,             // Auto-roster flag
    specializedToolNames: string[],         // Specialized tool names
    hasSpecializedTools: boolean,           // If specialized tools present
    // Caveman mode flags:
    cavemanActive: boolean,
    cavemanLevel: string,
    cavemanLite: boolean,
    cavemanFull: boolean,
    cavemanUltra: boolean,
    cavemanWenyanLite: boolean,
    cavemanWenyan: boolean,
    cavemanWenyanUltra: boolean,
    terseThinking: boolean,                 // Terse thinking mode (decoupled from caveman)
};
```

### E. Skills Filtering (lines 541-543)

```typescript
// Filter skills to only include those with read tool
const hasRead = tools?.has("read");
const filteredSkills = hasRead ? skills : [];
```

**Skills are ONLY rendered if the `read` tool is available.** This prevents agents without read access from seeing file-path-dependent skills.

### F. Output: SystemPromptBlock[]

The rendered prompt is split by `CACHE_BOUNDARY_MARKER` into stable + dynamic sections:

```typescript
// system-prompt.ts:576-586
const boundaryIndex = rendered.indexOf(CACHE_BOUNDARY_MARKER);
if (boundaryIndex === -1) {
    return [{ text: rendered, stable: true }];
}
const stablePrefix = rendered.slice(0, boundaryIndex);
const dynamicSuffix = rendered.slice(boundaryIndex + CACHE_BOUNDARY_MARKER.length);
const blocks: SystemPromptBlock[] = [{ text: stablePrefix, stable: true }];
if (dynamicSuffix.trim().length > 0) {
    blocks.push({ text: dynamicSuffix, stable: false });
}
return blocks;
```

**This enables cross-session prompt caching**: stable prefix cached, dynamic suffix refreshed per session.

---

## III. Complete Prompt Assembly Artifact Flow

```
User → SDK entry (sdk.ts)
  ↓
buildSystemPrompt() {
  
  // Phase 1: Parallel discovery
  ├─→ Load system customization files (.spell/custom-system-prompt.md, etc.)
  ├─→ Load append prompt (.spell/append-system-prompt.md)
  ├─→ Load context files (.spell/context/**, recursively)
  ├─→ Search for AGENTS.md in ancestors (depth 1-4)
  ├─→ loadSkills({
  │    ├─→ Load from ~/.spell/agent/skills/ (native:user)
  │    ├─→ Load from .spell/skills/ (native:project)
  │    ├─→ Load from .claude/skills/, .codex/skills/, etc.
  │    ├─→ Filter by enabled flags, ignore patterns, include patterns
  │    ├─→ Deduplicate by name (first win, rest skipped with warnings)
  │    └─→ Sort stable order (name case-insensitive, then name, then path)
  │  })
  └─→ Render caveman prompt (if mode active)

  // Phase 2: Build data object
  └─→ Collect tool descriptions, environment info, etc.
     └─→ Filter skills: only include if read tool available

  // Phase 3: Template rendering
  └─→ renderPromptTemplate(system-prompt.md, data)
      ├─→ Workspace section (environment, context files)
      ├─→ Identity section (role, communication, behavior, code-integrity, design-integrity, contract, stakes, procedure)
      ├─→ Skills section ({{#each skills}} ## {{name}} / {{description}})
      ├─→ Rules section ({{#each rules}} ## {{name}} (Domain: {{globs}}))
      ├─→ Tools section ({{#each toolInfo}} with descriptions)
      ├─→ AGENTS.md search results
      ├─→ MCP discovery summaries (if enabled)
      └─→ Append prompts + caveman formatting

  // Phase 4: Cache boundary split
  └─→ Split by CACHE_BOUNDARY_MARKER
      ├─→ Stable prefix (system prompt + identity + design rules)
      └─→ Dynamic suffix (skills, rules, tools, environment, AGENTS.md, MCP)
}
  ↓
Return SystemPromptBlock[] → AI message construction → LLM
```

---

## IV. Token Impact Analysis

### A. System Prompt Baseline
- **system-prompt.md template**: ~379 lines, ~8,500 chars (stable)
- **Identity + design sections**: ~3,500 chars (stable)
- **Workspace + date + environment**: ~800 chars (dynamic)

### B. Skills Contribution
- Each skill: `## <name>\n<description>\n\n`
- **Coding** (minimal): ~100 chars (description: "General coding guidance...")
- **Canvas**: ~250 chars (description: "Rich structured-data display...")
- **Brand-asset-gallery**: ~280 chars (description: "Generate brand asset variations...")
- **QML-testing**: ~290 chars (description: "Headless QML integration testing...")
- **Voice-agent**: ~250 chars (description: "Voice-to-agent flow...")
- **Semantic-compression**: ~280 chars (description: "Aggressively remove...")
- **System-prompts**: ~250 chars (description: "Write system prompts...")
- **Spell-server-setup**: ~280 chars (description: "Interactive wizard...")
- **Typst**: ~200 chars (description: "Write and compile...")

**Total if all 9 skills loaded**: ~2,100 chars (~525 tokens @ 4 chars/token)

### C. Rules Contribution
- Per rule: `## <name> (Domain: <globs>)\n<description>\n\n`
- Typical rule: ~200-400 chars
- **Currently**: 0 rules in this codebase (none found in discovery)

### D. Context Files & AGENTS.md
- Highly variable, depends on project
- Typical: 1-10 AGENTS.md files, 500-2,000 chars each

### E. Tool Descriptions
- Per tool: name + label + full description
- Typical tool: 200-600 chars
- **5 default tools** (read, bash, python, edit, write): ~2,000 chars total

### F. Dynamic Suffix Typical Size
- Environment metadata: ~500 chars
- AGENTS.md search: ~200 chars
- MCP discovery (if enabled): ~500-2,000 chars
- **Total dynamic**: ~1,200-2,500 chars

**Estimated total for typical session**: 12,000-16,000 chars (~3,000-4,000 tokens)

---

## V. Skill Metadata & Integration Points

### A. Skill Frontmatter Schema

Each SKILL.md or SKILL.org has optional YAML/org-keywords frontmatter:

```typescript
interface SkillFrontmatter {
    name?: string;              // Defaults to directory name
    description?: string;       // Required for rendering in prompt
    globs?: string[];          // File patterns (not used for prompt injection)
    alwaysApply?: boolean;     // Not implemented in current system
    enabled?: boolean;         // If false, skill is skipped
    version?: string;          // Informational
    [key: string]: unknown;    // Other fields ignored
}
```

### B. Skills in Capability System

Skills are a first-class **Capability** alongside Rules, Context Files, System Prompts:

```typescript
// capability/skill.ts
export const skillCapability = defineCapability<Skill>({
    id: "skills",
    displayName: "Skills",
    description: "Specialized knowledge and workflow files that extend agent capabilities",
    key: skill => skill.name,
    toExtensionId: skill => `skill:${skill.name}`,
    validate: skill => {
        if (!skill.name) return "Missing skill name";
        if (!skill.path) return "Missing skill path";
        return undefined;
    },
});
```

**Skill Extension IDs**: `skill:<name>` (e.g., `skill:coding`, `skill:canvas`)

### C. Discovery Provider Registration

Multiple providers can contribute skills. Currently active:

| Provider | User Path | Project Path | Load Function |
|----------|-----------|--------------|---|
| `native` | `~/.spell/agent/skills/` | `.spell/skills/` | `discovery/builtin.ts:252` |
| `claude` | `.claude/skills/` | `.claude/skills/` | `discovery/claude.ts:166` |
| `codex` | `.codex/skills/` | `.codex/skills/` | `discovery/codex.ts:214` |
| `agents` | (AGENTS.md parsed) | (AGENTS.md parsed) | `discovery/agents.ts:53` |
| `claude-plugins` | (from Claude plugins manifest) | — | `discovery/claude-plugins.ts:24` |
| Others | Similar patterns for opencode, cursor, windsurf, cline, github, vscode | See helpers.ts:17-72 |

Each provider implements `loadSkills()` returning `LoadResult<Skill>`.

---

## VI. Complete Inventory of System Prompt Inputs

### A. Every File That Reaches the Prompt

| Type | Source(s) | Load Path | Filtering | Example |
|------|-----------|-----------|-----------|---------|
| **Core template** | `system-prompt.md` | Compiled import | Always loaded | Identity + behavior + design |
| **Custom system prompt** | `.spell/custom-system-prompt.md` | File load | Optional override | Can replace entire core template |
| **Append prompt** | `.spell/append-system-prompt.md` | File load | Optional append | Additionalformat rules |
| **Caveman formatting** | `caveman.md` (compiled import) | Template | If caveman.defaultLevel ≠ "off" | "Think in compressed style" |
| **Context files** | `.spell/context/**` (recursive) | File load | If read tool available | Project-level documentation |
| **Rules** | `.spell/rules/**` | Discovery via capability | Loaded if discovered | Domain constraints |
| **AGENTS.md files** | Ancestor walk (depth 1-4) | File load | First match wins | Project development standards |
| **Skills** | `.spell/skills/`, `~/.spell/agent/skills/`, alt providers | Discovery via providers | If read tool available + enabled flags | 9 installed skills (optional) |
| **Tool descriptions** | Generated from tool metadata | Tool map | If tools parameter provided | read, bash, python, edit, write |
| **Environment metadata** | Collected from system | `getEnvironmentInfo()` | Always included | OS, GPU, CPU, workstation |
| **MCP discovery** | Claude plugin manifests + MCP servers | Discovery if enabled | If `mcpDiscoveryMode=true` | Server capabilities summary |

### B. Every Directory Scanned

| Directory | Recursive | Depth Limit | Filter | Scanned By |
|-----------|-----------|------------|--------|-----------|
| `.spell/custom-system-prompt.md` | N/A (single file) | — | — | `loadSystemPromptFiles()` |
| `.spell/append-system-prompt.md` | N/A (single file) | — | — | `loadSystemPromptFiles()` |
| `.spell/context/` | Yes, unlimited | — | `.gitignore` respected | `loadProjectContextFiles()` |
| `.spell/rules/` | Yes, unlimited | — | `.gitignore` respected | Capability system |
| `.spell/skills/` | No, direct children only | 1 | Dir with SKILL.md or SKILL.org | `scanSkillsFromDir()` |
| `.spell/agent/skills/` (user) | No, direct children only | 1 | Dir with SKILL.md or SKILL.org | `scanSkillsFromDir()` (native provider) |
| Ancestor dirs up to repoRoot | No, walk up only | — | Look for AGENTS.md at each level (depth 1-4 in content) | `listAgentsMdFiles()` |
| `.claude/skills/`, `.codex/skills/`, etc. | No, direct children only | 1 | Provider-specific | Discovery providers |

---

## VII. Token Cost Breakdown (Current State)

### Assumptions
- Handlebars rendering adds ~5% overhead
- 4 characters per token (Claude 3 baseline)
- All 9 skills loaded + 0 rules + typical 2 AGENTS.md files

| Component | Chars | Tokens | Notes |
|-----------|-------|--------|-------|
| Core system-prompt.md (stable) | 8,500 | 2,125 | Identity, behavior, design, contract, procedure |
| Workspace metadata | 600 | 150 | OS, CPU, GPU, workstation info |
| Tools section (5 default) | 2,000 | 500 | read, bash, python, edit, write |
| Context files (avg 2 files) | 2,000 | 500 | Project-local documentation |
| Skills (9 skills, descs only) | 2,100 | 525 | Coding through Typst |
| AGENTS.md search (2 files) | 1,000 | 250 | Development rules from ancestors |
| Append prompt (caveman, custom) | 500 | 125 | If caveman mode enabled |
| MCP discovery (optional) | 0-2,000 | 0-500 | If `mcpDiscoveryMode=true` |
| **Total Stable** | ~11,000 | ~2,775 | Cached across sessions |
| **Total Dynamic** | ~3,100-5,100 | ~775-1,275 | Refreshed per session |
| **Grand Total** | ~14,100-16,100 | ~3,550-4,050 | Typical session with all features |

---

## VIII. Load-Time Behavior

### A. Skill Loading Entry Points

```typescript
// SDK entry (sdk.ts:701)
const discovered = await logger.timeAsync("discoverSkills", async () =>
    discoverSkills(cwd, agentDir, { ...skillsSettings, disabledExtensions })
);

// Wrapper (sdk.ts:336)
export async function discoverSkills(
    cwd?: string,
    agentDir?: string,
    options?: SkillsSettings,
): Promise<Skill[]>

// Internal (extensibility/skills.ts:74)
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult>
```

### B. Skill Discovery Process

```typescript
// extensibility/skills.ts:74-176
loadSkills() {
    1. Check if enabled (default: true)
    2. For each provider (native, claude, codex, etc.):
       - Call provider's loadSkills() implementation
       - Get { items, warnings }
    3. Filter by:
       - disabledExtensions (IDs starting with "skill:")
       - isSourceEnabled() — check provider/level flags
       - matchesIgnorePatterns() — glob patterns to exclude
       - matchesIncludePatterns() — glob patterns to include (if specified)
    4. Deduplicate:
       - Check real paths (symlink-aware)
       - First-loaded skill wins on name collision
       - Log warnings for collisions
    5. Sort stable order:
       - Case-insensitive name, then name, then path
    6. Return { skills, warnings }
}
```

### C. Symbol Sources for Rendering

When rendering system-prompt.md, each skill renders as:

```markdown
## {{name}}
{{description}}
```

**Where `{{name}}` and `{{description}}` come from:**
- `name`: frontmatter field, or directory name if missing
- `description`: frontmatter field (required for rendering; skills without it are skipped silently)

---

## IX. Risks & Invariants

### A. Design Risks

1. **Skills without `read` tool are never rendered** — skills can't be tested without read access
   - **Invariant**: `hasRead = tools?.has("read")` (line 542)
   - **Impact**: If read tool unavailable, all skills silently dropped

2. **No skill validation at definition time** — syntax errors in SKILL.md not caught until rendering
   - **Invariant**: Skill `name` and `path` required by capability validator, but not description
   - **Impact**: Missing description doesn't fail load; skill just doesn't render

3. **Skill name collisions silently drop losers** — first loaded skill wins
   - **Invariant**: `if (existing) { warn and skip }` (extensibility/skills.ts:160-165)
   - **Impact**: symlinks or duplicate names across providers cause silent drops

4. **Provider evaluation order matters** — later providers overwrite earlier on collision
   - **Invariant**: Providers loaded in order: native, then others
   - **Impact**: User-level skills override project-level if same name

5. **AGENTS.md discovery is ancestor-only, not recursive** — can miss deeply nested rules
   - **Invariant**: `AGENTS_MD_MIN_DEPTH=1, MAX_DEPTH=4` (system-prompt.ts:40-41)
   - **Impact**: AGENTS.md in `src/lib/subdir/AGENTS.md` at depth 6 is ignored

### B. Token Cost Invariants

1. **All loaded skills render in prompt** — no per-skill token budgeting
   - **Invariant**: `{{#each skills}}` renders all in filteredSkills
   - **Impact**: Adding one skill increases token cost permanently

2. **Skills filter by tool availability, not by domain** — read tool is all-or-nothing
   - **Invariant**: `hasRead ? skills : []` (line 543)
   - **Impact**: No fine-grained skill selection; either all skills or none

3. **Dynamic section refreshes every session** — no caching of skills/rules
   - **Invariant**: `stable: false` for dynamic suffix (line 584)
   - **Impact**: Skills + rules always loaded fresh; no cross-session reuse

---

## X. Configuration & Control Points

### A. Settings Keys

**Location**: `packages/coding-agent/src/config/settings-schema.ts`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `skills.enabled` | boolean | `true` | Master switch for all skill loading |
| `skills.enablePiUser` | boolean | `true` | Load `~/.spell/agent/skills/` |
| `skills.enablePiProject` | boolean | `true` | Load `.spell/skills/` |
| `skills.enableCodexUser` | boolean | `true` | Load `.codex/skills/` (Codex IDE) |
| `skills.enableClaudeUser` | boolean | `true` | Load `.claude/skills/` (Claude desktop) |
| `skills.enableClaudeProject` | boolean | `true` | Load `.claude/skills/` in project |
| `skills.ignoredSkills` | string[] | `[]` | Glob patterns to exclude |
| `skills.includeSkills` | string[] | `[]` | Glob patterns to include (if set, only these) |
| `skills.customDirectories` | string[] | `[]` | Additional skill dirs to scan |
| `caveman.defaultLevel` | "off"\|"lite"\|"full"\|"ultra"\|"wenyan"\|... | "off" | Caveman mode toggle |
| `caveman.thinkingMode` | "normal"\|"caveman" | "caveman" | Thinking mode (decoupled from caveman output) |

### B. CLI Flags

**Location**: `packages/coding-agent/src/cli.ts`

```bash
bun run coding-agent \
    --no-skills                     # Disable all skill loading
    --skills=coding,canvas          # Include only these skills
    --skill-custom-dir=/path/to/dir # Add custom skill directory
```

### C. Runtime Overrides

**SDK usage**:
```typescript
const session = createAgentSession({
    skillsSettings: {
        enabled: false,                    // Disable skills
        ignoredSkills: ["voice-agent"],   // Skip voice-agent
        includeSkills: ["coding", "canvas"],  // Include only these
    },
});
```

---

## XI. Complete File List for Prompt Assembly

### Core Implementation
- `packages/coding-agent/src/system-prompt.ts` — main assembly pipeline
- `packages/coding-agent/src/prompts/system/system-prompt.md` — template
- `packages/coding-agent/src/prompts/system/caveman.md` — caveman formatting
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md` — custom override template
- `packages/coding-agent/src/config/prompt-templates.ts` — Handlebars-like rendering
- `packages/coding-agent/src/extensibility/skills.ts` — skill loading + filtering
- `packages/coding-agent/src/discovery/helpers.ts` — skill scanning + parsing
- `packages/coding-agent/src/discovery/builtin.ts` — native provider (user/project skills)
- `packages/coding-agent/src/discovery/*.ts` — other providers (claude, codex, etc.)

### Skill Files (9 installed)
- `.spell/skills/coding/SKILL.md`
- `.spell/skills/canvas/SKILL.md`
- `.spell/skills/brand-asset-gallery/SKILL.md`
- `.spell/skills/qml-testing/SKILL.md`
- `.spell/skills/voice-agent/SKILL.md`
- `.spell/skills/semantic-compression/SKILL.md`
- `.spell/skills/system-prompts/SKILL.md`
- `.spell/skills/spell-server-setup/SKILL.md`
- `.spell/skills/typst/SKILL.md`

### Configuration
- `packages/coding-agent/src/config/settings-schema.ts` — skill-related settings
- `packages/coding-agent/src/cli.ts` — CLI argument parsing for skills

### Tests
- `packages/coding-agent/test/system-prompt-templates.test.ts` — template rendering tests
- `packages/coding-agent/test/fixtures/skills/**` — validation fixtures

---

## XII. Recommendations

### A. For Monitoring Token Cost

1. **Add per-skill token budgeting** — estimate tokens per skill, warn if total exceeds threshold
2. **Implement skill prioritization** — allow marking skills as "high-value" vs "optional"
3. **Add telemetry** — log which skills rendered, which filtered, total tokens per session
4. **Create skill size report** — automated script to measure rendered token cost of each skill

### B. For Improving Skill Discovery

1. **Add base skills concept** — designate core skills (coding, system-prompts) as always-loaded if skills enabled
2. **Implement skill dependencies** — allow one skill to require another
3. **Add per-skill read-tool requirement** — some skills might not need read tool
4. **Validate at definition time** — require `description` in frontmatter, fail fast

### C. For System Prompt Clarity

1. **Tag skills by category** — add `category` or `domain` frontmatter field
2. **Suppress skill descriptions if too long** — render only name + single-line summary
3. **Add skill availability checklist** — show which skills loaded, which skipped and why
4. **Separate required vs optional skills** — visual distinction in rendered prompt

---

## Appendix A: Handlebars Rendering Helpers

**Template syntax used in system-prompt.md**:

```handlebars
{{#if condition}}       <!-- Conditional block -->
{{#each array}}         <!-- Loop over array items -->
{{#list array ...}}     <!-- Formatted list helper -->
{{value}}               <!-- Variable interpolation -->
{{SECTION_SEPERATOR}}   <!-- Custom helper for visual breaks -->
```

All these are handled by `renderPromptTemplate()` in `config/prompt-templates.ts`.

---

## Appendix B: Source Metadata Structure

Every skill carries source information:

```typescript
interface SourceMeta {
    provider: string;         // "native", "claude", "codex", etc.
    providerName: string;     // Display name
    path: string;             // Absolute path to SKILL.md file
    level: "user" | "project"; // Where it came from
}
```

Used for:
- Collision detection warnings
- Filtering by provider
- UI display of source
- Auditing which skills are active

---

**End of Specification**

This document captures the complete system-prompt assembly pipeline as of 2026-04-11. Every artifact, every file path, every decision point is accounted for.
