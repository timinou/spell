# Spell KDL Config Migration — Reference Specification

> Single source of truth for migrating all Spell configuration to `spell.kdl`.
> Every implementation item references this spec. If this spec and an org item disagree, this spec wins.

## 1. Overview

### Problem
Spell configuration is fragmented across 5+ formats and locations:
- `spell.kdl` (project root) — domain + task policies only
- `~/.spell/agent/config.yml` — ~139 settings (appearance, model, interaction, tools, tasks, providers)
- `~/.spell/agent/models.json` — provider registry, custom models, auth, discovery
- `~/.spell/agent/keybindings.json` — hotkey mappings
- `.spell/modes/*/MODE.md` — mode definitions with YAML frontmatter

### Solution
Consolidate everything into KDL as the single config format:
- **User-global**: `~/.spell/spell.kdl` (NEW — does not exist today)
- **Project-local**: `./spell.kdl` (EXISTS — currently domain + policies only)

Old formats (config.yml, models.json, keybindings.json) are deleted. A `spell migrate` CLI command converts them.

### Decisions (Settled)

1. **spell.kdl is the single config format** — replaces config.yml, models.json, keybindings.json
2. **Two file locations**: `~/.spell/spell.kdl` (user-global) + `./spell.kdl` (project). Project overrides user.
3. **File-level imports**: `import "./file.kdl"` and `import "spell.coding.typescript"` (built-in templates). Block-level imports deferred to follow-up.
4. **All config blocks**: appearance, model, providers, tools, tasks, interaction, keybindings, modes, skills, org, secrets
5. **Settings panel 3-tier writes**: Enter = session (in-memory), Shift+Enter = project spell.kdl, Ctrl+Shift+Enter = user spell.kdl
6. **Settings singleton backed by KDL** — config.yml deleted entirely
7. **Models/providers full migration** — TypeBox schemas for model config deleted, KDL-native validation, discovery caching stays in SQLite (unchanged)
8. **Modes**: spell.kdl `mode` blocks for project modes, MODE.md with KDL frontmatter (`---kdl ... ---`) for user/shared discoverable modes
9. **Keybindings**: KDL block at both project and user level, project overrides user
10. **`spell migrate` CLI command** converts old config.yml + models.json + keybindings.json to spell.kdl
11. **Hard cut** — old format files ignored after migration, startup warning if detected
12. **One mega-plan** with wave ordering

---

## 2. KDL Syntax Reference

### 2.1 Complete spell.kdl Grammar

```kdl
// ── Imports ──────────────────────────────────────────────────────────────
// File-level: merge entire file into this document
import "spell.coding.typescript"       // built-in template (existing behavior)
import "./team-policies.kdl"           // relative file import (NEW)

// ── Domain ───────────────────────────────────────────────────────────────
domain "coding"

// ── Appearance ───────────────────────────────────────────────────────────
appearance {
    theme dark="titanium" light="light"
    symbols "unicode"                  // "unicode" | "nerd" | "ascii"
    color-blind #false

    status-line preset="default" separator="powerline-thin" {
        left "pi" "model" "plan_mode" "path" "git"
        right "token_total" "cost" "context_pct" "time"
        show-hook-status #true
    }

    images show-inline=#true auto-resize=#true
}

// ── Model & Sampling ─────────────────────────────────────────────────────
model {
    thinking "high"                    // "minimal" | "low" | "medium" | "high" | "xhigh"
    max-thinking-tokens 16384

    roles {
        default "anthropic/claude-sonnet-4-20250514"
        smol "anthropic/claude-haiku-3"
        slow "anthropic/claude-sonnet-4-20250514"
        task "anthropic/claude-sonnet-4-20250514"
        commit "anthropic/claude-haiku-3"
    }

    sampling {
        temperature -1
        top-p -1
        top-k -1
        service-tier "none"
    }

    retry max=3 backoff-ms=1000
    compaction enabled=#true threshold=0.7 strategy="context-full"
}

// ── Providers ────────────────────────────────────────────────────────────
providers {
    web-search "auto"                  // "auto" | "exa" | "brave" | "perplexity" | ...
    code-search "grep"                 // "grep" | "exa"
    image "auto"                       // "auto" | "gemini" | "openrouter"

    provider "anthropic" {
        api-key "$ANTHROPIC_API_KEY"   // $PREFIX = env var lookup
    }

    provider "ollama" {
        base-url "http://localhost:11434"
        auth "none"                    // "none" | "apiKey" | "oauth"
        discovery type="ollama"

        model "llama3.2" {
            reasoning #false
            context-window 128000
        }
    }

    provider "company-proxy" {
        base-url "https://ai.company.com/v1"
        api "openai-completions"       // Api enum from pi-ai
        api-key "!vault read secret/ai/key"  // !PREFIX = shell command
        headers {
            X-Team "engineering"
        }
        compat {
            supports-store #false
            max-tokens-field "max_tokens"
        }
    }
}

// ── Tools ────────────────────────────────────────────────────────────────
tools {
    intent-tracing #true
    max-timeout 0                      // 0 = no limit

    bash enabled=#true
    fetch enabled=#true
    browser enabled=#true headless=#true
    org enabled=#true
    checkpoint enabled=#false

    mcp project-config=#true discovery-mode=#false notifications=#false
    async enabled=#false max-jobs=100
}

// ── Tasks (subagent delegation) ──────────────────────────────────────────
tasks {
    eager #false
    auto-roster #true
    max-concurrency 32
    max-recursion 2
    max-tool-calls 200
    cache-stagger-ms 800
    isolation mode="none" merge="patch" commits="generic"
}

// ── Interaction ──────────────────────────────────────────────────────────
interaction {
    steering #true
    caveman enabled=#false level="full"
    auto-compact #true

    context max-file-lines=2000 {
        promotion enabled=#true target="slow"
    }

    editing {
        auto-format #true
        preserve-indentation #true
    }
}

// ── Keybindings ──────────────────────────────────────────────────────────
keybindings {
    interrupt "escape"
    clear "ctrl+c"
    exit "ctrl+d"
    cycle-thinking "shift+tab"
    cycle-model "ctrl+p"
    select-model "ctrl+l"
    toggle-plan "alt+shift+p"
    history-search "ctrl+r"
    expand-tools "ctrl+o"
    toggle-thinking "ctrl+t"
    external-editor "ctrl+g"
    follow-up "ctrl+enter"
    paste-image "ctrl+v"
    toggle-stt "alt+h"
}

// ── Layers & Policies ────────────────────────────────────────────────────
layer "core" description="Core business logic and shared types"
layer "api" description="API endpoints, routes, and middleware"

policy "core-quality" layer="core" {
    gate-commit #true
}

policy "api-quality" layer="api" {
    gate-commit #true
    gate-cmd "bun test"
}

// ── Modes ────────────────────────────────────────────────────────────────
mode "plan" extends="base" {
    command "/plan"
    read-only #true
    context-policy "fresh"
    instructions "./modes/plan/MODE.md"

    tools {
        allow "read" "grep" "find" "fetch" "web_search" "org" "ask"
    }

    categories "features" "bugs" "projects" "followups"
    gates { decomposition #true }
}

// ── Skills ───────────────────────────────────────────────────────────────
skills {
    enabled #true
    enable-commands #true
    custom-directories "./custom-skills"
    ignored "voice-agent"
}

// ── Org ──────────────────────────────────────────────────────────────────
org {
    enabled #true
    todo-keywords "INIT" "ITEM" "DOING" "REVIEW" "DONE" "BLOCKED"
}
```

### 2.2 Settings Path → KDL Path Mapping

Settings use dot-notation paths (e.g., `compaction.enabled`). KDL uses hierarchical nodes. The mapping is:

| Settings Path | KDL Location |
|---|---|
| `theme.dark` | `appearance { theme dark="titanium" }` |
| `symbolPreset` | `appearance { symbols "unicode" }` |
| `defaultThinkingLevel` | `model { thinking "high" }` |
| `compaction.enabled` | `model { compaction enabled=#true }` |
| `compaction.strategy` | `model { compaction strategy="context-full" }` |
| `retry.enabled` | `model { retry enabled=#true }` |
| `steeringMode` | `interaction { steering #true }` |
| `caveman.defaultLevel` | `interaction { caveman level="full" }` |
| `browser.headless` | `tools { browser headless=#true }` |
| `task.maxRecursionDepth` | `tasks { max-recursion 2 }` |
| `todo.enabled` | `tasks { auto-roster #true }` |
| `org.enabled` | `org { enabled #true }` |
| `edit.fuzzyMatch` | `interaction { editing { fuzzy-match #true } }` |

The complete mapping table lives in a new file: `packages/coding-agent/src/config/kdl-settings-map.ts`.

### 2.3 KDL Value Resolution

Values in KDL strings support two prefixes for dynamic resolution (reusing existing `resolveConfigValue` from `packages/coding-agent/src/config/resolve-config-value.ts`):

- `$ENV_VAR_NAME` — environment variable lookup
- `!shell command` — execute shell command, cache result

These apply ONLY to string values in the `providers` block (api-key, headers). Regular settings use literal values.

---

## 3. Architecture

### 3.1 File Loading Order

```
1. Built-in defaults (SETTINGS_SCHEMA defaults, unchanged)
2. ~/.spell/spell.kdl (user-global KDL) — NEW
3. ./spell.kdl (project-local KDL) — EXPANDED
4. CLI flags / env vars (runtime overrides, unchanged)
```

Priority: later overrides earlier. Within a file, `import` nodes are resolved first, then local nodes override.

### 3.2 New Files

| File | Purpose |
|---|---|
| `packages/coding-agent/src/config/kdl-settings-map.ts` | Bidirectional mapping between SettingPath and KDL node paths |
| `packages/coding-agent/src/config/kdl-reader.ts` | Parse spell.kdl into RawSettings (replaces YAML loading) |
| `packages/coding-agent/src/config/kdl-writer.ts` | Round-trip write settings back to spell.kdl (preserving comments/formatting) |
| `packages/coding-agent/src/config/kdl-providers.ts` | Parse/write providers block (replaces ConfigFile<ModelsConfig>) |
| `packages/coding-agent/src/config/kdl-keybindings.ts` | Parse/write keybindings block (replaces keybindings.json loading) |
| `packages/coding-agent/src/config/kdl-modes.ts` | Parse mode blocks from spell.kdl |
| `packages/coding-agent/src/config/kdl-helpers.ts` | Shared KDL node accessor/mutator helpers (extracted from task-policies-kdl.ts + new) |
| `packages/coding-agent/src/cli/migrate-cli.ts` | Migration logic: YAML/JSON → KDL conversion |
| `packages/coding-agent/src/commands/migrate.ts` | `spell migrate` Command class |
| `specs/kdl-config-migration.md` | This spec (reference for all implementation items) |

### 3.3 Modified Files

| File | Change |
|---|---|
| `packages/coding-agent/src/config/spell-kdl.ts` | Expand parseSpellKdl to handle ALL node types (not just domain/import/layer/policy). Add user-level loading. Add file-relative import resolution. Return expanded SpellProjectConfig. |
| `packages/coding-agent/src/config/settings.ts` | Replace YAML loading (#load, #loadYaml, #saveNow) with KDL loading/saving. Add `set()` tier parameter. Remove config.yml references. |
| `packages/coding-agent/src/config/settings-schema.ts` | Add KDL block metadata to each setting definition (which KDL block + node path it maps to). |
| `packages/coding-agent/src/config/keybindings.ts` | Replace JSON loading with KDL block parsing. Support project + user level. |
| `packages/coding-agent/src/config/model-registry.ts` | Replace ConfigFile<ModelsConfig> + TypeBox schemas with KDL provider block parsing. Keep registerProvider() runtime API unchanged. |
| `packages/coding-agent/src/config/task-policies-kdl.ts` | Extract shared helpers to kdl-helpers.ts. Keep policy-specific parsing. |
| `packages/coding-agent/src/config/task-policies.ts` | Remove YAML fallback path (parseTaskPolicies YAML function). Only KDL sources remain. |
| `packages/coding-agent/src/utils/frontmatter.ts` | Add KDL frontmatter support (`---kdl ... ---` delimiter). |
| `packages/coding-agent/src/discovery/builtin.ts` | Update mode loading to support KDL frontmatter in MODE.md files. |
| `packages/coding-agent/src/discovery/mode-helpers.ts` | Update mode resolution to handle KDL frontmatter output format. |
| `packages/coding-agent/src/domain/detection.ts` | Remove domain.json fallback. Only spell.kdl + CLI override. |
| `packages/coding-agent/src/cli/init-cli.ts` | Update generateSpellKdl to produce expanded spell.kdl with all blocks. |
| `packages/coding-agent/src/cli/config-cli.ts` | Update `spell config` to read/write KDL instead of YAML. |
| `packages/coding-agent/src/cli.ts` | Register `spell migrate` command. |
| `packages/coding-agent/src/main.ts` | Add startup warning for legacy config files. |
| `packages/coding-agent/src/modes/components/settings-selector.ts` | Add modifier key handling for 3-tier writes (Enter/Shift+Enter/Ctrl+Shift+Enter). |
| `packages/coding-agent/src/modes/controllers/selector-controller.ts` | Pass write tier through to settings.set(). |
| `packages/tui/src/components/settings-list.ts` | Propagate modifier keys from SettingsList to callbacks. |
| `packages/coding-agent/src/capability/mode.ts` | Keep ModeConfigFrontmatter type — it's format-agnostic (same fields whether from YAML or KDL). |

### 3.4 Deleted Files / Code

| What | Why |
|---|---|
| `config.yml` loading in settings.ts (#loadYaml, YAML.parse/stringify) | Replaced by KDL reader/writer |
| `ModelsConfigSchema` TypeBox schema in model-registry.ts | Replaced by KDL validation in kdl-providers.ts |
| `ModelsConfigFile` ConfigFile instance in model-registry.ts | Replaced by KDL loading |
| `parseTaskPolicies()` YAML function in task-policies.ts | Only KDL path remains |
| YAML fallback in `loadTaskPolicies()` | Step 3 (`.spell/task-policies.yml`) removed |
| `domain.json` fallback in detection.ts | Only spell.kdl + CLI |

### 3.5 Unchanged

| What | Why |
|---|---|
| `Settings.get()` / `Settings.set()` API | Callers (~67 files) see no change. Internal storage changes from YAML to KDL. |
| `Settings.isolated()` / `_resetSettingsForTest()` | Test helpers unchanged. |
| `SETTINGS_SCHEMA` / `SettingPath` / `SettingValue<P>` types | Schema stays. Only persistence format changes. |
| `SETTING_HOOKS` | Side-effect hooks unchanged. |
| `ModelRegistry.registerProvider()` | Runtime registration API unchanged. |
| `resolveConfigValue()` / `resolveHeaders()` | Value resolution unchanged, just called from KDL context. |
| `AuthStorage` / model discovery protocols | Discovery stays SQLite-based. |
| `KeybindingsManager.getKeys()` / `.matches()` / `.getDisplayString()` | Public API unchanged. |
| `ModeConfigFrontmatter` type | Same fields regardless of frontmatter format. |
| `parseFrontmatter()` consumers (10 files) | They call parseFrontmatter() which now also handles KDL. No consumer changes. |

---

## 4. Detailed Design

### 4.1 kdl-helpers.ts — Shared KDL Accessors

Extract from `task-policies-kdl.ts` and extend:

```typescript
// packages/coding-agent/src/config/kdl-helpers.ts
import type { Node, Document } from "@bgotink/kdl";

// ── Existing (moved from task-policies-kdl.ts) ──
export function getStringArgument(node: Node, index?: number): string | undefined;
export function getBooleanArgument(node: Node, index?: number): boolean | undefined;
export function getStringProperty(node: Node, name: string): string | undefined;

// ── New helpers ──
export function getNumberArgument(node: Node, index?: number): number | undefined;
export function getNumberProperty(node: Node, name: string): number | undefined;
export function getBooleanProperty(node: Node, name: string): boolean | undefined;
export function getStringArguments(node: Node): string[];

/** Get a child node by name from a node's children block */
export function getChildNode(node: Node, name: string): Node | undefined;

/** Get all child nodes, optionally filtered by name */
export function getChildNodes(node: Node, name?: string): Node[];

/** Get a top-level node by name from a document */
export function getDocumentNode(doc: Document, name: string): Node | undefined;

// ── Node creation helpers (for writer) ──
export function createStringNode(name: string, value: string): Node;
export function createBooleanNode(name: string, value: boolean): Node;
export function createNumberNode(name: string, value: number): Node;
export function createPropertyNode(name: string, props: Record<string, string | number | boolean>): Node;
```

### 4.2 kdl-settings-map.ts — Bidirectional Mapping

```typescript
// packages/coding-agent/src/config/kdl-settings-map.ts

export interface KdlSettingMapping {
  /** The SettingPath (dot-notation) */
  path: string;
  /** KDL block name (top-level node) */
  block: string;
  /** Path within the block to the value node (dot-separated for nested children) */
  nodePath: string;
  /** How to read the value: "argument" (positional) or "property" (named) */
  accessor: "argument" | "property";
  /** Property name when accessor is "property" */
  propertyName?: string;
  /** Argument index when accessor is "argument" (default 0) */
  argumentIndex?: number;
}

/** Complete mapping of all ~139 SettingPaths to KDL locations */
export const KDL_SETTINGS_MAP: Record<string, KdlSettingMapping> = {
  "theme.dark": { path: "theme.dark", block: "appearance", nodePath: "theme", accessor: "property", propertyName: "dark" },
  "theme.light": { path: "theme.light", block: "appearance", nodePath: "theme", accessor: "property", propertyName: "light" },
  "symbolPreset": { path: "symbolPreset", block: "appearance", nodePath: "symbols", accessor: "argument" },
  "colorBlindMode": { path: "colorBlindMode", block: "appearance", nodePath: "color-blind", accessor: "argument" },
  "defaultThinkingLevel": { path: "defaultThinkingLevel", block: "model", nodePath: "thinking", accessor: "argument" },
  "compaction.enabled": { path: "compaction.enabled", block: "model", nodePath: "compaction", accessor: "property", propertyName: "enabled" },
  "compaction.strategy": { path: "compaction.strategy", block: "model", nodePath: "compaction", accessor: "property", propertyName: "strategy" },
  // ... all 139 settings
};

/** Reverse lookup: given a KDL block + node path, find the SettingPath */
export function findSettingPath(block: string, nodePath: string, propertyName?: string): string | undefined;

/** Get the KDL mapping for a SettingPath */
export function getKdlMapping(settingPath: string): KdlSettingMapping | undefined;
```

### 4.3 kdl-reader.ts — Parse KDL to RawSettings

```typescript
// packages/coding-agent/src/config/kdl-reader.ts
import type { Document } from "@bgotink/kdl";

/**
 * Parse a KDL document into a RawSettings object compatible with Settings.#global / #project.
 * 
 * Reads all known blocks (appearance, model, interaction, tools, tasks, keybindings, etc.)
 * and maps their KDL node values to the corresponding SettingPath keys.
 * 
 * Unknown nodes are silently ignored (forward compatibility).
 * Parse errors in individual blocks log warnings but don't fail the whole load.
 */
export function kdlDocumentToSettings(doc: Document): RawSettings;

/**
 * Load and parse a spell.kdl file into RawSettings.
 * Returns empty RawSettings on ENOENT.
 * Logs warning and returns empty on parse error.
 */
export async function loadKdlSettings(filePath: string): Promise<RawSettings>;
```

### 4.4 kdl-writer.ts — Round-Trip KDL Writer

```typescript
// packages/coding-agent/src/config/kdl-writer.ts
import type { Document } from "@bgotink/kdl";

/**
 * Update a KDL document with changed settings, preserving formatting and comments.
 * 
 * For each modified SettingPath:
 * 1. Look up the KDL mapping (block + node path)
 * 2. Find or create the block node in the document
 * 3. Find or create the value node within the block
 * 4. Update the value (argument or property)
 * 
 * Returns the modified document (original is mutated in place for format preservation).
 */
export function applySettingsToKdl(doc: Document, changes: Map<string, unknown>): Document;

/**
 * Write settings to a spell.kdl file with round-trip format preservation.
 * 
 * 1. Read existing file content (if exists)
 * 2. Parse into Document
 * 3. Apply changes via applySettingsToKdl()
 * 4. Format and write back
 * 
 * Uses withFileLock() for concurrent write safety.
 */
export async function writeKdlSettings(filePath: string, changes: Map<string, unknown>): Promise<void>;
```

### 4.5 kdl-providers.ts — Provider Config

```typescript
// packages/coding-agent/src/config/kdl-providers.ts

/**
 * Equivalent of ModelsConfig but parsed from KDL.
 * Same runtime types — just different parse source.
 */
export interface KdlProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  auth?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  discovery?: { type: string };
  models?: KdlModelConfig[];
  modelOverrides?: Record<string, unknown>;
}

export interface KdlModelConfig {
  id: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/**
 * Parse the `providers` block from a KDL document.
 * Returns provider configs keyed by provider name.
 */
export function parseProvidersBlock(doc: Document): {
  providers: Record<string, KdlProviderConfig>;
  webSearch?: string;
  codeSearch?: string;
  image?: string;
};

/**
 * Validate provider configuration (same rules as validateProviderConfiguration in model-registry.ts).
 * Throws descriptive errors on invalid config.
 */
export function validateKdlProviderConfig(name: string, config: KdlProviderConfig): void;
```

### 4.6 kdl-keybindings.ts — Keybindings

```typescript
// packages/coding-agent/src/config/kdl-keybindings.ts

/**
 * Parse the `keybindings` block from a KDL document.
 * Returns a KeybindingsConfig (same type as current JSON loading produces).
 */
export function parseKeybindingsBlock(doc: Document): KeybindingsConfig;
```

### 4.7 kdl-modes.ts — Mode Blocks

```typescript
// packages/coding-agent/src/config/kdl-modes.ts

/**
 * Parse `mode` nodes from a KDL document into ModeConfigFrontmatter objects.
 * These are the same type produced by YAML frontmatter parsing.
 */
export function parseModeBlocks(doc: Document): Array<{
  name: string;
  config: ModeConfigFrontmatter;
  instructionsPath?: string;
}>;
```

### 4.8 Settings.ts Changes

The Settings class changes from YAML to KDL storage:

```typescript
// Current: set() always writes to #global (persisted to config.yml)
// New: set() accepts optional tier parameter

export type WriteTier = "session" | "project" | "user";

class Settings {
  // NEW: tier-aware set
  set<P extends SettingPath>(path: P, value: SettingValue<P>, tier?: WriteTier): void {
    const segments = parsePath(path);
    switch (tier ?? "session") {
      case "session":
        setByPath(this.#overrides, segments, value);
        break;
      case "project":
        setByPath(this.#project, segments, value);
        this.#projectModified.add(path);
        this.#queueSave("project");
        break;
      case "user":
        setByPath(this.#global, segments, value);
        this.#globalModified.add(path);
        this.#queueSave("user");
        break;
    }
    this.#rebuildMerged();
    const hook = SETTING_HOOKS[path];
    if (hook) hook(value, prev);
  }

  // CHANGED: #load() reads KDL instead of YAML
  async #load(): Promise<Settings> {
    // 1. Load user-global: ~/.spell/spell.kdl
    this.#global = await loadKdlSettings(this.#userKdlPath);
    // 2. Load project-local: ./spell.kdl (settings blocks only, not domain/policies)
    this.#project = await loadKdlSettings(this.#projectKdlPath);
    // 3. Load project settings from capability system (unchanged — .claude/settings.json etc.)
    const capabilitySettings = await this.#loadProjectSettings();
    this.#project = this.#deepMerge(this.#project, capabilitySettings);
    this.#rebuildMerged();
    this.#fireAllHooks();
    return this;
  }

  // CHANGED: #saveNow() writes KDL instead of YAML
  async #saveNow(target: "user" | "project"): Promise<void> {
    const filePath = target === "user" ? this.#userKdlPath : this.#projectKdlPath;
    const modified = target === "user" ? this.#globalModified : this.#projectModified;
    const changes = new Map<string, unknown>();
    for (const path of modified) {
      changes.set(path, this.get(path));
    }
    modified.clear();
    await writeKdlSettings(filePath, changes);
  }
}
```

**CRITICAL**: The default tier for `set()` changes from "user" (current behavior — writes to config.yml) to "session" (in-memory only). This is intentional — the settings panel UI now distinguishes tiers via modifier keys. Code that calls `settings.set()` directly (agent-session.ts, caveman.ts, etc.) continues to use "session" tier by default, which matches the current runtime-only behavior of those settings.

Exception: `spell config set` CLI command should default to "user" tier (persistent), matching current behavior.

### 4.9 Frontmatter KDL Support

```typescript
// packages/coding-agent/src/utils/frontmatter.ts — addition

// Current: handles --- YAML --- delimiters
// New: also handles ---kdl ... --- delimiters

export function parseFrontmatter(
  content: string,
  options?: ParseFrontmatterOptions,
): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = normalizeLineEndings(content);
  
  // Try KDL frontmatter first (---kdl ... ---)
  if (normalized.startsWith("---kdl")) {
    const endIndex = normalized.indexOf("\n---", 6);
    if (endIndex !== -1) {
      const kdlContent = normalized.slice(7, endIndex); // after "---kdl\n"
      const body = normalized.slice(endIndex + 4).replace(/^\n/, "");
      const parsed = parseKdlFrontmatter(kdlContent);
      return { frontmatter: normalizeKeys({ ...fallback, ...parsed }), body };
    }
  }
  
  // Fall back to YAML frontmatter (existing behavior)
  // ... existing code unchanged ...
}
```

The `parseKdlFrontmatter` function parses a KDL fragment containing a single `mode` node and converts it to the same `Record<string, unknown>` shape that YAML frontmatter produces. This means `ModeConfigFrontmatter` type stays unchanged, and all downstream consumers (mode-helpers.ts, interactive-mode.ts) work without modification.

### 4.10 Model Registry Changes

```typescript
// packages/coding-agent/src/config/model-registry.ts — changes

class ModelRegistry {
  // CHANGED: constructor accepts KDL-parsed provider configs instead of models.json path
  constructor(
    authStorage: AuthStorage,
    providerConfigs?: Record<string, KdlProviderConfig>,
    cacheDbPath?: string,
  ) { ... }

  // CHANGED: #loadCustomModels reads from KDL-parsed configs instead of ConfigFile
  #loadCustomModels(): CustomModelsResult {
    // Instead of ModelsConfigFile.load() + TypeBox validation,
    // uses this.#providerConfigs which was already parsed + validated from KDL
  }
}

// DELETED: ModelsConfigSchema (TypeBox schema)
// DELETED: ModelsConfigFile (ConfigFile instance)
// DELETED: ModelsConfig type (replaced by KdlProviderConfig)
// KEPT: validateProviderConfiguration() — called by both KDL parser and registerProvider()
// KEPT: buildCustomModel() — same logic, different input source
// KEPT: ProviderOverride, DiscoveryProviderConfig interfaces
```

### 4.11 Keybindings Changes

```typescript
// packages/coding-agent/src/config/keybindings.ts — changes

class KeybindingsManager {
  // CHANGED: create() loads from KDL instead of JSON
  static async create(
    userKdlPath?: string,   // ~/.spell/spell.kdl
    projectKdlPath?: string // ./spell.kdl
  ): Promise<KeybindingsManager> {
    // 1. Load user keybindings block from user spell.kdl
    // 2. Load project keybindings block from project spell.kdl
    // 3. Merge (project overrides user, both override defaults)
    // 4. Create KeybindingsManager + set editor keybindings
  }

  // DELETED: #loadFromFile() (JSON-specific)
}
```

### 4.12 Import Resolution Enhancement

Current `parseSpellKdl` only resolves built-in template names (e.g., `"spell.coding.typescript"`). We add relative file import resolution:

```typescript
// Enhanced import resolution in spell-kdl.ts

case "import": {
  const ns = getStringArgument(node);
  if (!ns) break;
  
  if (ns.startsWith("./") || ns.startsWith("../")) {
    // File-relative import — resolve against the spell.kdl file's directory
    const importPath = path.resolve(baseDir, ns);
    const content = await Bun.file(importPath).text();
    const importedDoc = parse(content);
    // Merge all nodes from imported document
    mergeKdlDocument(result, importedDoc);
  } else {
    // Built-in template (existing behavior)
    const templateContent = resolveTemplate(ns);
    // ... existing template merge logic ...
  }
}
```

### 4.13 Settings Panel 3-Tier Writes

The settings panel currently calls `settings.set(path, value)` on Enter. We add modifier key support:

**TUI layer** (`packages/tui/src/components/settings-list.ts`):
- SettingsList `onChange` callback gets a new optional parameter: `modifier?: "shift" | "ctrl+shift"`
- SettingsList `handleInput()` detects Shift+Enter and Ctrl+Shift+Enter

**Settings selector** (`packages/coding-agent/src/modes/components/settings-selector.ts`):
- `SettingsCallbacks.onChange` signature adds `tier?: WriteTier`
- Maps modifier → tier: none → "session", shift → "project", ctrl+shift → "user"

**Selector controller** (`packages/coding-agent/src/modes/controllers/selector-controller.ts`):
- `handleSettingChange()` passes tier to `settings.set()`

### 4.14 spell migrate Command

```typescript
// packages/coding-agent/src/cli/migrate-cli.ts

/**
 * Convert legacy config files to spell.kdl.
 * 
 * Steps:
 * 1. Detect legacy files:
 *    - ~/.spell/agent/config.yml → user settings
 *    - ~/.spell/agent/models.json → user providers
 *    - ~/.spell/agent/keybindings.json → user keybindings
 * 2. Parse each legacy file
 * 3. Generate KDL document with all blocks
 * 4. Write to ~/.spell/spell.kdl (user) or ./spell.kdl (project, if project-level configs found)
 * 5. Print summary of what was migrated
 * 
 * Does NOT delete legacy files (user can do that manually after verifying).
 */
export async function runMigrateCommand(args: MigrateCommandArgs): Promise<void>;

/**
 * Convert a RawSettings object to KDL document text.
 */
export function settingsToKdl(settings: RawSettings): string;

/**
 * Convert ModelsConfig (from models.json) to KDL providers block text.
 */
export function modelsConfigToKdl(config: ModelsConfig): string;

/**
 * Convert KeybindingsConfig (from keybindings.json) to KDL keybindings block text.
 */
export function keybindingsToKdl(config: KeybindingsConfig): string;
```

### 4.15 Startup Warning

```typescript
// In main.ts, after Settings.init():
const legacyFiles = await detectLegacyConfigFiles();
if (legacyFiles.length > 0) {
  logger.warn("Legacy config files detected. Run `spell migrate` to convert to spell.kdl.", {
    files: legacyFiles,
  });
}
```

---

## 5. Migration Path

### 5.1 User Workflow

1. User runs `spell migrate`
2. Command reads config.yml + models.json + keybindings.json
3. Generates `~/.spell/spell.kdl` with all settings
4. Prints: "Migration complete. Legacy files kept as backup. Verify ~/.spell/spell.kdl, then delete old files."
5. Next `spell` launch reads from KDL, ignores old files, warns if old files still present

### 5.2 Backward Compatibility

- Old files are NOT read after migration. Hard cut.
- If both old and new files exist, only spell.kdl is used.
- Startup warning reminds user to run `spell migrate` or delete old files.

---

## 6. Testing Strategy

### 6.1 Unit Tests (per module)

| Module | Test File | Key Scenarios |
|---|---|---|
| kdl-helpers.ts | test/config/kdl-helpers.test.ts | All accessor types, missing values, type coercion |
| kdl-settings-map.ts | test/config/kdl-settings-map.test.ts | Forward/reverse lookup, all 139 paths mapped |
| kdl-reader.ts | test/config/kdl-reader.test.ts | Full document parse, partial documents, unknown nodes ignored, parse errors handled |
| kdl-writer.ts | test/config/kdl-writer.test.ts | Round-trip preservation, create new blocks, update existing values, concurrent write safety |
| kdl-providers.ts | test/config/kdl-providers.test.ts | Provider parse, validation errors, custom models, discovery config, compat settings |
| kdl-keybindings.ts | test/config/kdl-keybindings.test.ts | Parse block, default merging, unknown actions ignored |
| kdl-modes.ts | test/config/kdl-modes.test.ts | Mode block parsing, extends, tools allow/deny, instructions path |
| frontmatter.ts (KDL) | test/utils/frontmatter-kdl.test.ts | KDL frontmatter parse, fallback to YAML, mixed documents |
| migrate-cli.ts | test/cli/migrate-command.test.ts | Full migration flow, partial files, empty files, already-migrated |

### 6.2 Integration Tests

| Scenario | Test File | What It Proves |
|---|---|---|
| Settings round-trip | test/config/settings-kdl-integration.test.ts | Settings.init() → get() → set(tier) → flush() → re-read equals |
| Config loading hierarchy | test/config/config-loading-hierarchy.test.ts (UPDATE existing) | spell.kdl > .spell/task-policies.kdl > (no YAML fallback) |
| Model registry from KDL | test/model-registry.test.ts (UPDATE existing) | ModelRegistry with KDL-parsed providers works identically |
| Keybindings from KDL | test/keybindings-display.test.ts (UPDATE existing) | KeybindingsManager.create() with KDL file |
| Legacy file detection | test/config/legacy-detection.test.ts | Startup warning fires when old files present |
| spell init | test/cli/init-command.test.ts (UPDATE existing) | Generated spell.kdl includes all blocks |

### 6.3 Test Patterns

Follow existing patterns:
- `bun:test` framework (describe/it/expect)
- Temp directories with `fs.mkdtemp()` + `afterEach` cleanup
- `Settings.isolated()` for unit tests that need settings
- `_resetSettingsForTest()` in `beforeEach` for integration tests
- `Bun.write()` for fixture files
- Relative imports from `../../src/` (not package name) for config tests

### 6.4 What NOT to Test

- Individual setting values (they're just data in the mapping table)
- KDL parse/format library internals (tested by @bgotink/kdl)
- Unchanged APIs (Settings.get, ModelRegistry.registerProvider, etc.)

---

## 7. Execution Waves

### Wave 1: Foundation (no consumers changed)
1. **kdl-helpers.ts** — Extract + extend shared helpers
2. **kdl-settings-map.ts** — Complete bidirectional mapping
3. **kdl-reader.ts** — Parse KDL documents to RawSettings
4. **kdl-writer.ts** — Round-trip KDL writer

### Wave 2: Block Parsers (no consumers changed)
5. **kdl-providers.ts** — Provider block parser + validation
6. **kdl-keybindings.ts** — Keybindings block parser
7. **kdl-modes.ts** — Mode block parser
8. **frontmatter.ts** — Add KDL frontmatter support

### Wave 3: Core Migration (consumers changed)
9. **spell-kdl.ts** — Expand to handle all blocks + file imports + user-level
10. **settings.ts** — Replace YAML with KDL, add WriteTier
11. **model-registry.ts** — Replace TypeBox/ConfigFile with KDL providers

### Wave 4: Peripheral Migration
12. **keybindings.ts** — Replace JSON with KDL
13. **task-policies.ts** — Remove YAML fallback
14. **detection.ts** — Remove domain.json fallback
15. **builtin.ts + mode-helpers.ts** — KDL frontmatter for modes

### Wave 5: UI + CLI
16. **Settings panel 3-tier writes** — TUI + settings-selector + controller
17. **init-cli.ts** — Update `spell init` to generate full spell.kdl
18. **migrate-cli.ts + commands/migrate.ts** — `spell migrate` command
19. **main.ts** — Legacy file warning
20. **config-cli.ts** — Update `spell config` for KDL

---

## 8. Risk Mitigation

| Risk | Mitigation |
|---|---|
| Round-trip format corruption | @bgotink/kdl preserves formatting metadata. Test with real-world config files containing comments. |
| Settings regression | Settings.get()/set() API unchanged. All 50+ Settings.isolated() test usages continue to work. |
| Model registry breakage | validateProviderConfiguration() function preserved. Same validation rules, different input source. |
| Discovery protocol changes | Discovery stays in SQLite. Only the static config source changes from JSON to KDL. |
| Keybindings lost | KeybindingsManager.inMemory() used in tests stays unchanged. Only the file loading changes. |
| Mode resolution breaks | ModeConfigFrontmatter type unchanged. parseFrontmatter() adds KDL path without changing return type. |
| File locking races | Existing withFileLock() pattern reused for KDL writes. |
| Migration data loss | `spell migrate` does NOT delete old files. User verifies then deletes manually. |

---

## 9. Verification Checklist (Plan-Level)

After all waves complete:

1. `bun check:ts` passes
2. `bun lint:ts` passes
3. All existing tests pass (no regressions)
4. All new tests pass
5. `spell init` in a TypeScript project generates complete spell.kdl
6. `spell migrate` converts existing config.yml + models.json + keybindings.json
7. `spell config get theme.dark` reads from KDL
8. `spell config set theme.dark monokai` writes to KDL
9. Settings panel opens, shows all tabs, modifier keys work for tier selection
10. Model selection works with KDL-defined providers
11. Custom keybindings from KDL apply correctly
12. Mode definitions with KDL frontmatter load and resolve
13. File-relative imports (`import "./team.kdl"`) work in spell.kdl
14. Legacy file startup warning appears when old files present
