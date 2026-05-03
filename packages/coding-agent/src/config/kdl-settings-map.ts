/**
 * Bidirectional mapping between SettingPath (dot-notation) and KDL node locations.
 *
 * Used by the KDL reader (parse KDL → RawSettings) and writer (RawSettings → KDL).
 * Every setting in SETTINGS_SCHEMA is either mapped here or explicitly excluded.
 */

import type { SettingPath } from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface KdlSettingMapping {
	/** KDL block name (top-level node) — e.g., "appearance", "model", "tools" */
	block: string;
	/** Node name within the block (dot-separated for nested children) — e.g., "theme", "compaction" */
	nodePath: string;
	/** How to read the value: "argument" (positional) or "property" (named key=value) */
	accessor: "argument" | "property";
	/** Property name when accessor is "property" */
	propertyName?: string;
	/** Argument index when accessor is "argument" (default 0) */
	argumentIndex?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Excluded Settings (internal state, not persisted to KDL)
// ═══════════════════════════════════════════════════════════════════════════

/** Settings that are internal state and not written to spell.kdl */
export const EXCLUDED_FROM_KDL = new Set<string>([
	"lastChangelogVersion",
	"shellPath",
	"extensions",
	"disabledExtensions",
	"disabledProviders",
	// STT paths are system-specific, not config
	"stt.whisperPath",
	"stt.modelPath",
]);

// ═══════════════════════════════════════════════════════════════════════════
// Complete Mapping
// ═══════════════════════════════════════════════════════════════════════════

/** Complete mapping of all SettingPaths to KDL locations */
export const KDL_SETTINGS_MAP: Partial<Record<SettingPath, KdlSettingMapping>> = {
	// ── Appearance ────────────────────────────────────────────────────────
	"theme.dark": { block: "appearance", nodePath: "theme", accessor: "property", propertyName: "dark" },
	"theme.light": { block: "appearance", nodePath: "theme", accessor: "property", propertyName: "light" },
	symbolPreset: { block: "appearance", nodePath: "symbols", accessor: "argument" },
	colorBlindMode: { block: "appearance", nodePath: "color-blind", accessor: "argument" },
	"statusLine.preset": { block: "appearance", nodePath: "status-line", accessor: "property", propertyName: "preset" },
	"statusLine.separator": {
		block: "appearance",
		nodePath: "status-line",
		accessor: "property",
		propertyName: "separator",
	},
	"statusLine.showHookStatus": {
		block: "appearance",
		nodePath: "status-line.show-hook-status",
		accessor: "argument",
	},
	"statusLine.leftSegments": { block: "appearance", nodePath: "status-line.left", accessor: "argument" },
	"statusLine.rightSegments": { block: "appearance", nodePath: "status-line.right", accessor: "argument" },
	"statusLine.segmentOptions": { block: "appearance", nodePath: "status-line.segment-options", accessor: "argument" },
	"terminal.showImages": {
		block: "appearance",
		nodePath: "images",
		accessor: "property",
		propertyName: "show-inline",
	},
	"images.autoResize": { block: "appearance", nodePath: "images", accessor: "property", propertyName: "auto-resize" },
	"images.blockImages": {
		block: "appearance",
		nodePath: "images",
		accessor: "property",
		propertyName: "block-images",
	},
	"display.tabWidth": { block: "appearance", nodePath: "display", accessor: "property", propertyName: "tab-width" },
	"display.showTokenUsage": {
		block: "appearance",
		nodePath: "display",
		accessor: "property",
		propertyName: "show-token-usage",
	},
	showHardwareCursor: { block: "appearance", nodePath: "show-hardware-cursor", accessor: "argument" },
	clearOnShrink: { block: "appearance", nodePath: "clear-on-shrink", accessor: "argument" },
	hideThinkingBlock: { block: "appearance", nodePath: "hide-thinking-block", accessor: "argument" },
	"tools.artifactSpillThreshold": {
		block: "appearance",
		nodePath: "artifacts",
		accessor: "property",
		propertyName: "spill-threshold",
	},
	"tools.artifactTailBytes": {
		block: "appearance",
		nodePath: "artifacts",
		accessor: "property",
		propertyName: "tail-bytes",
	},
	"tools.artifactTailLines": {
		block: "appearance",
		nodePath: "artifacts",
		accessor: "property",
		propertyName: "tail-lines",
	},

	// ── Model & Sampling ─────────────────────────────────────────────────
	defaultThinkingLevel: { block: "model", nodePath: "thinking", accessor: "argument" },
	enabledModels: { block: "model", nodePath: "enabled-models", accessor: "argument" },
	modelRoles: { block: "model", nodePath: "roles", accessor: "argument" },
	"retry.enabled": { block: "model", nodePath: "retry", accessor: "property", propertyName: "enabled" },
	"retry.maxRetries": { block: "model", nodePath: "retry", accessor: "property", propertyName: "max" },
	"retry.baseDelayMs": { block: "model", nodePath: "retry", accessor: "property", propertyName: "backoff-ms" },
	repeatToolDescriptions: { block: "model", nodePath: "repeat-tool-descriptions", accessor: "argument" },
	"compaction.enabled": { block: "model", nodePath: "compaction", accessor: "property", propertyName: "enabled" },
	"compaction.strategy": { block: "model", nodePath: "compaction", accessor: "property", propertyName: "strategy" },
	"compaction.thresholdPercent": {
		block: "model",
		nodePath: "compaction",
		accessor: "property",
		propertyName: "threshold",
	},
	"compaction.thresholdTokens": {
		block: "model",
		nodePath: "compaction",
		accessor: "property",
		propertyName: "threshold-tokens",
	},
	"compaction.reserveTokens": {
		block: "model",
		nodePath: "compaction",
		accessor: "property",
		propertyName: "reserve-tokens",
	},
	"compaction.keepRecentTokens": {
		block: "model",
		nodePath: "compaction",
		accessor: "property",
		propertyName: "keep-recent-tokens",
	},
	"compaction.handoffSaveToDisk": {
		block: "model",
		nodePath: "compaction",
		accessor: "property",
		propertyName: "handoff-save-to-disk",
	},
	"compaction.autoContinue": {
		block: "model",
		nodePath: "compaction",
		accessor: "property",
		propertyName: "auto-continue",
	},
	"compaction.remoteEnabled": {
		block: "model",
		nodePath: "compaction",
		accessor: "property",
		propertyName: "remote-enabled",
	},
	"compaction.remoteEndpoint": {
		block: "model",
		nodePath: "compaction",
		accessor: "property",
		propertyName: "remote-endpoint",
	},
	temperature: { block: "model", nodePath: "sampling.temperature", accessor: "argument" },
	topP: { block: "model", nodePath: "sampling.top-p", accessor: "argument" },
	topK: { block: "model", nodePath: "sampling.top-k", accessor: "argument" },
	minP: { block: "model", nodePath: "sampling.min-p", accessor: "argument" },
	presencePenalty: { block: "model", nodePath: "sampling.presence-penalty", accessor: "argument" },
	repetitionPenalty: { block: "model", nodePath: "sampling.repetition-penalty", accessor: "argument" },
	serviceTier: { block: "model", nodePath: "sampling.service-tier", accessor: "argument" },
	"thinkingBudgets.minimal": {
		block: "model",
		nodePath: "thinking-budgets",
		accessor: "property",
		propertyName: "minimal",
	},
	"thinkingBudgets.low": { block: "model", nodePath: "thinking-budgets", accessor: "property", propertyName: "low" },
	"thinkingBudgets.medium": {
		block: "model",
		nodePath: "thinking-budgets",
		accessor: "property",
		propertyName: "medium",
	},
	"thinkingBudgets.high": {
		block: "model",
		nodePath: "thinking-budgets",
		accessor: "property",
		propertyName: "high",
	},
	"branchSummary.enabled": {
		block: "model",
		nodePath: "branch-summary",
		accessor: "property",
		propertyName: "enabled",
	},
	"branchSummary.reserveTokens": {
		block: "model",
		nodePath: "branch-summary",
		accessor: "property",
		propertyName: "reserve-tokens",
	},

	// ── Interaction ──────────────────────────────────────────────────────
	steeringMode: { block: "interaction", nodePath: "steering", accessor: "argument" },
	"caveman.defaultLevel": { block: "interaction", nodePath: "caveman", accessor: "property", propertyName: "level" },
	"caveman.showStatus": {
		block: "interaction",
		nodePath: "caveman",
		accessor: "property",
		propertyName: "show-status",
	},
	"caveman.thinkingMode": {
		block: "interaction",
		nodePath: "caveman",
		accessor: "property",
		propertyName: "thinking-mode",
	},
	"caveman.affectSubagents": {
		block: "interaction",
		nodePath: "caveman",
		accessor: "property",
		propertyName: "affect-subagents",
	},
	followUpMode: { block: "interaction", nodePath: "follow-up-mode", accessor: "argument" },
	interruptMode: { block: "interaction", nodePath: "interrupt-mode", accessor: "argument" },
	doubleEscapeAction: { block: "interaction", nodePath: "double-escape-action", accessor: "argument" },
	treeFilterMode: { block: "interaction", nodePath: "tree-filter-mode", accessor: "argument" },
	autocompleteMaxVisible: { block: "interaction", nodePath: "autocomplete-max-visible", accessor: "argument" },
	"startup.quiet": { block: "interaction", nodePath: "startup", accessor: "property", propertyName: "quiet" },
	collapseChangelog: { block: "interaction", nodePath: "collapse-changelog", accessor: "argument" },
	"completion.notify": {
		block: "interaction",
		nodePath: "completion",
		accessor: "property",
		propertyName: "notify",
	},
	"ask.timeout": { block: "interaction", nodePath: "ask", accessor: "property", propertyName: "timeout" },
	"ask.notify": { block: "interaction", nodePath: "ask", accessor: "property", propertyName: "notify" },
	"contextPromotion.enabled": {
		block: "interaction",
		nodePath: "context.promotion",
		accessor: "property",
		propertyName: "enabled",
	},
	"loop.autoApproveEnabled": {
		block: "interaction",
		nodePath: "loop",
		accessor: "property",
		propertyName: "auto-approve",
	},
	"loop.autoApproveTimeoutMs": {
		block: "interaction",
		nodePath: "loop",
		accessor: "property",
		propertyName: "auto-approve-timeout-ms",
	},

	// ── Editing ──────────────────────────────────────────────────────────
	"edit.mode": { block: "interaction", nodePath: "editing.mode", accessor: "argument" },
	"edit.fuzzyMatch": {
		block: "interaction",
		nodePath: "editing",
		accessor: "property",
		propertyName: "fuzzy-match",
	},
	"edit.fuzzyThreshold": {
		block: "interaction",
		nodePath: "editing",
		accessor: "property",
		propertyName: "fuzzy-threshold",
	},
	"edit.streamingAbort": {
		block: "interaction",
		nodePath: "editing",
		accessor: "property",
		propertyName: "streaming-abort",
	},
	"edit.previewResolvePolicy": {
		block: "interaction",
		nodePath: "editing",
		accessor: "property",
		propertyName: "preview-resolve-policy",
	},
	readLineNumbers: { block: "interaction", nodePath: "read-line-numbers", accessor: "argument" },
	readHashLines: { block: "interaction", nodePath: "read-hash-lines", accessor: "argument" },
	"read.defaultLimit": {
		block: "interaction",
		nodePath: "read",
		accessor: "property",
		propertyName: "default-limit",
	},

	// ── Memories ─────────────────────────────────────────────────────────
	"memories.enabled": { block: "interaction", nodePath: "memories", accessor: "property", propertyName: "enabled" },
	"memories.maxRolloutsPerStartup": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "max-rollouts-per-startup",
	},
	"memories.maxRolloutAgeDays": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "max-rollout-age-days",
	},
	"memories.minRolloutIdleHours": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "min-rollout-idle-hours",
	},
	"memories.threadScanLimit": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "thread-scan-limit",
	},
	"memories.maxRawMemoriesForGlobal": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "max-raw-memories-for-global",
	},
	"memories.stage1Concurrency": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "stage1-concurrency",
	},
	"memories.stage1LeaseSeconds": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "stage1-lease-seconds",
	},
	"memories.stage1RetryDelaySeconds": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "stage1-retry-delay-seconds",
	},
	"memories.phase2LeaseSeconds": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "phase2-lease-seconds",
	},
	"memories.phase2RetryDelaySeconds": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "phase2-retry-delay-seconds",
	},
	"memories.phase2HeartbeatSeconds": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "phase2-heartbeat-seconds",
	},
	"memories.rolloutPayloadPercent": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "rollout-payload-percent",
	},
	"memories.fallbackTokenLimit": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "fallback-token-limit",
	},
	"memories.summaryInjectionTokenLimit": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "summary-injection-token-limit",
	},
	"memories.phase1CooldownMinutes": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "phase1-cooldown-minutes",
	},
	"memories.phase1MaxInputTokens": {
		block: "interaction",
		nodePath: "memories",
		accessor: "property",
		propertyName: "phase1-max-input-tokens",
	},

	// ── TTSR ─────────────────────────────────────────────────────────────
	"ttsr.enabled": { block: "interaction", nodePath: "ttsr", accessor: "property", propertyName: "enabled" },
	"ttsr.contextMode": {
		block: "interaction",
		nodePath: "ttsr",
		accessor: "property",
		propertyName: "context-mode",
	},
	"ttsr.interruptMode": {
		block: "interaction",
		nodePath: "ttsr",
		accessor: "property",
		propertyName: "interrupt-mode",
	},
	"ttsr.repeatMode": { block: "interaction", nodePath: "ttsr", accessor: "property", propertyName: "repeat-mode" },
	"ttsr.repeatGap": { block: "interaction", nodePath: "ttsr", accessor: "property", propertyName: "repeat-gap" },

	// ── STT ──────────────────────────────────────────────────────────────
	"stt.enabled": { block: "interaction", nodePath: "stt", accessor: "property", propertyName: "enabled" },
	"stt.language": { block: "interaction", nodePath: "stt", accessor: "property", propertyName: "language" },
	"stt.modelName": { block: "interaction", nodePath: "stt", accessor: "property", propertyName: "model-name" },

	// ── Tools ────────────────────────────────────────────────────────────
	"tools.intentTracing": { block: "tools", nodePath: "intent-tracing", accessor: "argument" },
	"tools.maxTimeout": { block: "tools", nodePath: "max-timeout", accessor: "argument" },
	"bashInterceptor.enabled": {
		block: "tools",
		nodePath: "bash-interceptor",
		accessor: "property",
		propertyName: "enabled",
	},
	"bashInterceptor.simpleLs": {
		block: "tools",
		nodePath: "bash-interceptor",
		accessor: "property",
		propertyName: "simple-ls",
	},
	"python.toolMode": { block: "tools", nodePath: "python", accessor: "property", propertyName: "tool-mode" },
	"python.kernelMode": { block: "tools", nodePath: "python", accessor: "property", propertyName: "kernel-mode" },
	"python.sharedGateway": {
		block: "tools",
		nodePath: "python",
		accessor: "property",
		propertyName: "shared-gateway",
	},
	"lsp.enabled": { block: "tools", nodePath: "lsp", accessor: "property", propertyName: "enabled" },
	"lsp.formatOnWrite": { block: "tools", nodePath: "lsp", accessor: "property", propertyName: "format-on-write" },
	"lsp.diagnosticsOnWrite": {
		block: "tools",
		nodePath: "lsp",
		accessor: "property",
		propertyName: "diagnostics-on-write",
	},
	"lsp.diagnosticsOnEdit": {
		block: "tools",
		nodePath: "lsp",
		accessor: "property",
		propertyName: "diagnostics-on-edit",
	},
	"todo.enabled": { block: "tools", nodePath: "todo", accessor: "property", propertyName: "enabled" },
	"todo.reminders": { block: "tools", nodePath: "todo", accessor: "property", propertyName: "reminders" },
	"todo.reminders.max": { block: "tools", nodePath: "todo", accessor: "property", propertyName: "reminders-max" },
	"todo.eager": { block: "tools", nodePath: "todo", accessor: "property", propertyName: "eager" },
	"find.enabled": { block: "tools", nodePath: "find", accessor: "property", propertyName: "enabled" },
	"grep.enabled": { block: "tools", nodePath: "grep", accessor: "property", propertyName: "enabled" },
	"grep.contextBefore": {
		block: "tools",
		nodePath: "grep",
		accessor: "property",
		propertyName: "context-before",
	},
	"grep.contextAfter": { block: "tools", nodePath: "grep", accessor: "property", propertyName: "context-after" },
	"astGrep.enabled": { block: "tools", nodePath: "ast-grep", accessor: "property", propertyName: "enabled" },
	"astEdit.enabled": { block: "tools", nodePath: "ast-edit", accessor: "property", propertyName: "enabled" },
	"notebook.enabled": { block: "tools", nodePath: "notebook", accessor: "property", propertyName: "enabled" },
	"renderMermaid.enabled": {
		block: "tools",
		nodePath: "render-mermaid",
		accessor: "property",
		propertyName: "enabled",
	},
	"calc.enabled": { block: "tools", nodePath: "calc", accessor: "property", propertyName: "enabled" },
	"inspect_image.enabled": {
		block: "tools",
		nodePath: "inspect-image",
		accessor: "property",
		propertyName: "enabled",
	},
	"checkpoint.enabled": { block: "tools", nodePath: "checkpoint", accessor: "property", propertyName: "enabled" },
	"fetch.enabled": { block: "tools", nodePath: "fetch", accessor: "property", propertyName: "enabled" },
	"web_search.enabled": { block: "tools", nodePath: "web-search", accessor: "property", propertyName: "enabled" },
	"browser.enabled": { block: "tools", nodePath: "browser", accessor: "property", propertyName: "enabled" },
	"browser.headless": { block: "tools", nodePath: "browser", accessor: "property", propertyName: "headless" },
	"async.enabled": { block: "tools", nodePath: "async", accessor: "property", propertyName: "enabled" },
	"async.maxJobs": { block: "tools", nodePath: "async", accessor: "property", propertyName: "max-jobs" },
	"mcp.enableProjectConfig": { block: "tools", nodePath: "mcp", accessor: "property", propertyName: "project-config" },
	"mcp.discoveryMode": { block: "tools", nodePath: "mcp", accessor: "property", propertyName: "discovery-mode" },
	"mcp.notifications": { block: "tools", nodePath: "mcp", accessor: "property", propertyName: "notifications" },
	"mcp.notificationDebounceMs": {
		block: "tools",
		nodePath: "mcp",
		accessor: "property",
		propertyName: "notification-debounce-ms",
	},
	"org.enabled": { block: "tools", nodePath: "org", accessor: "property", propertyName: "enabled" },

	// ── Tasks ────────────────────────────────────────────────────────────
	"task.isolation.mode": {
		block: "tasks",
		nodePath: "isolation",
		accessor: "property",
		propertyName: "mode",
	},
	"task.isolation.merge": {
		block: "tasks",
		nodePath: "isolation",
		accessor: "property",
		propertyName: "merge",
	},
	"task.isolation.commits": {
		block: "tasks",
		nodePath: "isolation",
		accessor: "property",
		propertyName: "commits",
	},
	"task.eager": { block: "tasks", nodePath: "eager", accessor: "argument" },
	"task.autoRoster": { block: "tasks", nodePath: "auto-roster", accessor: "argument" },
	"task.maxConcurrency": { block: "tasks", nodePath: "max-concurrency", accessor: "argument" },
	"task.maxRecursionDepth": { block: "tasks", nodePath: "max-recursion", accessor: "argument" },
	"task.maxToolCalls": { block: "tasks", nodePath: "max-tool-calls", accessor: "argument" },
	"task.cacheStaggerMs": { block: "tasks", nodePath: "cache-stagger-ms", accessor: "argument" },
	"task.disabledAgents": { block: "tasks", nodePath: "disabled-agents", accessor: "argument" },
	"task.agentModelOverrides": { block: "tasks", nodePath: "agent-model-overrides", accessor: "argument" },
	"tasks.todoClearDelay": { block: "tasks", nodePath: "todo-clear-delay", accessor: "argument" },

	// ── Skills ───────────────────────────────────────────────────────────
	"skills.enabled": { block: "skills", nodePath: "enabled", accessor: "argument" },
	"skills.enableSkillCommands": { block: "skills", nodePath: "enable-commands", accessor: "argument" },
	"skills.enableCodexUser": { block: "skills", nodePath: "enable-codex-user", accessor: "argument" },
	"skills.enableClaudeUser": { block: "skills", nodePath: "enable-claude-user", accessor: "argument" },
	"skills.enableClaudeProject": { block: "skills", nodePath: "enable-claude-project", accessor: "argument" },
	"skills.enablePiUser": { block: "skills", nodePath: "enable-pi-user", accessor: "argument" },
	"skills.enablePiProject": { block: "skills", nodePath: "enable-pi-project", accessor: "argument" },
	"skills.customDirectories": { block: "skills", nodePath: "custom-directories", accessor: "argument" },
	"skills.ignoredSkills": { block: "skills", nodePath: "ignored", accessor: "argument" },
	"skills.includeSkills": { block: "skills", nodePath: "include", accessor: "argument" },

	// ── Commands ─────────────────────────────────────────────────────────
	"commands.enableClaudeUser": {
		block: "skills",
		nodePath: "commands-claude-user",
		accessor: "argument",
	},
	"commands.enableClaudeProject": {
		block: "skills",
		nodePath: "commands-claude-project",
		accessor: "argument",
	},

	// ── Org ──────────────────────────────────────────────────────────────
	"org.todoKeywords": { block: "org", nodePath: "todo-keywords", accessor: "argument" },
	"org.planDraftCategory": { block: "org", nodePath: "plan-draft-category", accessor: "argument" },
	"org.planActiveCategory": { block: "org", nodePath: "plan-active-category", accessor: "argument" },
	"org.planDraftState": { block: "org", nodePath: "plan-draft-state", accessor: "argument" },
	"org.planActiveState": { block: "org", nodePath: "plan-active-state", accessor: "argument" },
	// ── Plan mode ────────────────────────────────────────────────────────
	"planMode.allowedFolders": { block: "plan-mode", nodePath: "allowed-folders", accessor: "argument" },

	// ── Providers (simple settings, not provider blocks) ─────────────────
	"secrets.enabled": { block: "providers", nodePath: "secrets", accessor: "property", propertyName: "enabled" },
	"providers.webSearch": { block: "providers", nodePath: "web-search", accessor: "argument" },
	"providers.codeSearch": { block: "providers", nodePath: "code-search", accessor: "argument" },
	"providers.image": { block: "providers", nodePath: "image", accessor: "argument" },
	"providers.kimiApiFormat": { block: "providers", nodePath: "kimi-api-format", accessor: "argument" },
	"providers.openaiWebsockets": { block: "providers", nodePath: "openai-websockets", accessor: "argument" },
	"providers.parallelFetch": { block: "providers", nodePath: "parallel-fetch", accessor: "argument" },
	"exa.enabled": { block: "providers", nodePath: "exa", accessor: "property", propertyName: "enabled" },
	"exa.enableSearch": { block: "providers", nodePath: "exa", accessor: "property", propertyName: "enable-search" },
	"exa.enableResearcher": {
		block: "providers",
		nodePath: "exa",
		accessor: "property",
		propertyName: "enable-researcher",
	},
	"exa.enableWebsets": {
		block: "providers",
		nodePath: "exa",
		accessor: "property",
		propertyName: "enable-websets",
	},

	// ── Commit ───────────────────────────────────────────────────────────
	"commit.mapReduceEnabled": {
		block: "model",
		nodePath: "commit",
		accessor: "property",
		propertyName: "map-reduce-enabled",
	},
	"commit.mapReduceMinFiles": {
		block: "model",
		nodePath: "commit",
		accessor: "property",
		propertyName: "map-reduce-min-files",
	},
	"commit.mapReduceMaxFileTokens": {
		block: "model",
		nodePath: "commit",
		accessor: "property",
		propertyName: "map-reduce-max-file-tokens",
	},
	"commit.mapReduceTimeoutMs": {
		block: "model",
		nodePath: "commit",
		accessor: "property",
		propertyName: "map-reduce-timeout-ms",
	},
	"commit.mapReduceMaxConcurrency": {
		block: "model",
		nodePath: "commit",
		accessor: "property",
		propertyName: "map-reduce-max-concurrency",
	},
	"commit.changelogMaxDiffChars": {
		block: "model",
		nodePath: "commit",
		accessor: "property",
		propertyName: "changelog-max-diff-chars",
	},

	// ── Fluid ────────────────────────────────────────────────────────────
	"fluid.concurrency": { block: "tasks", nodePath: "fluid", accessor: "property", propertyName: "concurrency" },
	"fluid.fastPlan": { block: "tasks", nodePath: "fluid", accessor: "property", propertyName: "fast-plan" },
	"fluid.debug": { block: "tasks", nodePath: "fluid", accessor: "property", propertyName: "debug" },
};

// ═══════════════════════════════════════════════════════════════════════════
// Lookup Functions
// ═══════════════════════════════════════════════════════════════════════════

/** Get the KDL mapping for a SettingPath. Returns undefined if not mapped. */
export function getKdlMapping(settingPath: string): KdlSettingMapping | undefined {
	return KDL_SETTINGS_MAP[settingPath as SettingPath];
}

/** Reverse lookup: given a KDL block + node path + optional property name, find the SettingPath. */
export function findSettingPath(block: string, nodePath: string, propertyName?: string): string | undefined {
	for (const [path, mapping] of Object.entries(KDL_SETTINGS_MAP)) {
		if (!mapping) continue;
		if (mapping.block === block && mapping.nodePath === nodePath) {
			if (propertyName === undefined || mapping.propertyName === propertyName) {
				return path;
			}
		}
	}
	return undefined;
}

/** Get all unique KDL block names from the mapping */
export function getAllBlocks(): string[] {
	const blocks = new Set<string>();
	for (const mapping of Object.values(KDL_SETTINGS_MAP)) {
		if (mapping) blocks.add(mapping.block);
	}
	return [...blocks];
}

/** Get all mappings for a specific block */
export function getMappingsForBlock(block: string): Array<[string, KdlSettingMapping]> {
	return Object.entries(KDL_SETTINGS_MAP).filter(
		(entry): entry is [string, KdlSettingMapping] => entry[1] !== undefined && entry[1].block === block,
	);
}
