/**
 * Settings singleton with sync get/set and background persistence.
 *
 * Usage:
 *   import { settings } from "./settings";
 *
 *   const enabled = settings.get("compaction.enabled");  // sync read
 *   settings.set("theme.dark", "titanium");               // sync write, saves in background
 *
 * For tests:
 *   const isolated = Settings.isolated({ "compaction.enabled": false });
 */

import * as path from "node:path";
import {
	getAgentDbPath,
	getAgentDir,
	getLocalKdlPath,
	getProjectDir,
	getProjectKdlPath,
	getUserKdlPath,
	logger,
	postmortem,
	procmgr,
	setDefaultTabWidth,
} from "@oh-my-pi/pi-utils";
import type { ModelRole } from "../config/model-registry";
import { isLightTheme, setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "../modes/theme/theme";
import { type EditMode, normalizeEditMode } from "../patch";
import { maybeRunMigration } from "../migration";
import { AgentStorage } from "../session/agent-storage";
import { loadKdlSettings } from "./kdl-reader";
import { writeKdlSettings } from "./kdl-writer";
import {
	type BashInterceptorRule,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
} from "./settings-schema";

// Re-export types that callers need
export type * from "./settings-schema";
export * from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Raw settings object — nested key-value store */
export interface RawSettings {
	[key: string]: unknown;
}

/**
 * Write tier for settings persistence.
 *
 * Read precedence (highest → lowest; last write per key wins):
 *   session  in-memory                          volatile
 *   local    <cwd>/.local/spell.kdl             gitignored, machine
 *   project  <cwd>/spell.kdl                    committed, team
 *   user     ~/.config/spell/spell.kdl          XDG-style global
 */
export type WriteTier = "session" | "local" | "project" | "user";

/** Persistent tiers (i.e. tiers that map to a file on disk). */
export type PersistTier = Exclude<WriteTier, "session">;

export interface SettingsOptions {
	/** Current working directory for project settings discovery */
	cwd?: string;
	/** Agent directory for persistent storage (runtime state only) */
	agentDir?: string;
	/** Don't persist to disk (for tests) */
	inMemory?: boolean;
	/** Initial overrides */
	overrides?: Partial<Record<SettingPath, unknown>>;
	/** Explicit user-tier KDL path (defaults to getUserKdlPath()) */
	userKdlPath?: string;
	/** Explicit project-tier KDL path (defaults to <cwd>/spell.kdl) */
	projectKdlPath?: string;
	/** Explicit local-tier KDL path (defaults to <cwd>/.local/spell.kdl) */
	localKdlPath?: string;
	/**
	 * One-shot YAML/JSON → KDL migration knobs. Plumbed through to
	 * `maybeRunMigration()` so callers (CLI flags, tests) can force a decision
	 * without importing the migration module directly. Removing the migrator
	 * later — see migration/README.md — also deletes this option type.
	 */
	migrate?: {
		/** Force-yes: translate every detected legacy source without prompting. */
		yes?: boolean;
		/** Force-no: skip the prompt entirely. */
		no?: boolean;
		/** Override interactive (default: true). */
		interactive?: boolean;
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Path Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a dotted path into segments.
 * "compaction.enabled" → ["compaction", "enabled"]
 * "theme.dark" → ["theme", "dark"]
 */
function parsePath(path: string): string[] {
	return path.split(".");
}

/**
 * Get a nested value from an object by path segments.
 */
function getByPath(obj: RawSettings, segments: string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Set a nested value in an object by path segments.
 * Creates intermediate objects as needed.
 */
function setByPath(obj: RawSettings, segments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!(segment in current) || typeof current[segment] !== "object" || current[segment] === null) {
			current[segment] = {};
		}
		current = current[segment] as RawSettings;
	}
	current[segments[segments.length - 1]] = value;
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Class
// ═══════════════════════════════════════════════════════════════════════════

export class Settings {
	#userKdlPath: string;
	#projectKdlPath: string;
	#localKdlPath: string;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorage | null = null;
	/** Plumbed-through migrator options (W1; deleted with migration/). */
	#migrateOptions: SettingsOptions["migrate"];

	/** User settings from user spell.kdl (lowest precedence) */
	#global: RawSettings = {};
	/** Project settings from project-local spell.kdl */
	#project: RawSettings = {};
	/** Local-only settings from <cwd>/.local/spell.kdl (highest persisted) */
	#local: RawSettings = {};
	/** Runtime overrides (not persisted; session tier) */
	#overrides: RawSettings = {};
	/** Merged view (user ← project ← local ← overrides) */
	#merged: RawSettings = {};

	/** Paths modified for user-tier save */
	#userModified = new Set<string>();
	/** Paths modified for project-tier save */
	#projectModified = new Set<string>();
	/** Paths modified for local-tier save */
	#localModified = new Set<string>();

	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;

	/** Whether to persist changes */
	#persist: boolean;

	constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());

		// KDL config paths are decoupled from agentDir. agentDir holds runtime
		// state (sessions/plugins/logs); KDL config lives elsewhere.
		if (options.inMemory) {
			this.#userKdlPath = "";
			this.#projectKdlPath = "";
			this.#localKdlPath = "";
		} else {
			this.#userKdlPath = options.userKdlPath ?? getUserKdlPath();
			this.#projectKdlPath = options.projectKdlPath ?? getProjectKdlPath(this.#cwd);
			this.#localKdlPath = options.localKdlPath ?? getLocalKdlPath(this.#cwd);
		}
		this.#persist = !options.inMemory;
		this.#migrateOptions = options.migrate;

		if (options.overrides) {
			for (const [key, value] of Object.entries(options.overrides)) {
				setByPath(this.#overrides, parsePath(key), value);
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		if (globalInstancePromise) return globalInstancePromise;

		const instance = new Settings(options);
		const promise = instance.#load();
		globalInstancePromise = promise;

		return promise.then(
			instance => {
				globalInstance = instance;
				postmortem.register("settings-flush", () => instance.flush());
				globalInstancePromise = Promise.resolve(instance);
				return instance;
			},
			error => {
				globalInstance = null;
				throw error;
			},
		);
	}

	/**
	 * Create an isolated instance for testing.
	 * Does not affect the global singleton.
	 */
	static isolated(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#rebuildMerged();
		return instance;
	}

	/**
	 * Get the global singleton.
	 * Throws if not initialized.
	 */
	static get instance(): Settings {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		return globalInstance;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Core API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get a setting value (sync).
	 * Returns the merged value from global + project + overrides, or the default.
	 */
	get<P extends SettingPath>(path: P): SettingValue<P> {
		const segments = parsePath(path);
		const value = getByPath(this.#merged, segments);
		if (value !== undefined) {
			return value as SettingValue<P>;
		}
		return getDefault(path);
	}

	/**
	 * Set a setting value (sync).
	 *
	 * `tier` defaults to `"user"` (persisted to `~/.config/spell/spell.kdl`).
	 * Other tiers: `"session"` (in-memory only), `"local"` (./.local/spell.kdl,
	 * machine-local), `"project"` (./spell.kdl, committed).
	 * Triggers hooks for settings that have side effects.
	 */
	set<P extends SettingPath>(path: P, value: SettingValue<P>, tier?: WriteTier): void {
		const prev = this.get(path);
		const segments = parsePath(path);
		switch (tier ?? "user") {
			case "session":
				setByPath(this.#overrides, segments, value);
				break;
			case "local":
				setByPath(this.#local, segments, value);
				this.#localModified.add(path);
				this.#queueSave();
				break;
			case "project":
				setByPath(this.#project, segments, value);
				this.#projectModified.add(path);
				this.#queueSave();
				break;
			case "user":
				setByPath(this.#global, segments, value);
				this.#userModified.add(path);
				this.#queueSave();
				break;
		}
		this.#rebuildMerged();

		// Trigger hook if exists
		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(value, prev);
		}
	}

	/**
	 * Apply runtime overrides (not persisted).
	 */
	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const segments = parsePath(path);
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
	}

	/**
	 * Clear a runtime override.
	 */
	clearOverride(path: SettingPath): void {
		const segments = parsePath(path);
		let current = this.#overrides;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			if (!(segment in current)) return;
			current = current[segment] as RawSettings;
		}
		delete current[segments[segments.length - 1]];
		this.#rebuildMerged();
	}

	/**
	 * Flush any pending saves to disk.
	 * Call before exit to ensure all changes are persisted.
	 */
	async flush(): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		if (this.#savePromise) {
			await this.#savePromise;
		}
		if (this.#userModified.size > 0 || this.#projectModified.size > 0 || this.#localModified.size > 0) {
			await this.#saveNow();
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getStorage(): AgentStorage | null {
		return this.#storage;
	}

	getCwd(): string {
		return this.#cwd;
	}

	getAgentDir(): string {
		return this.#agentDir;
	}

	getPlansDirectory(): string {
		return path.join(this.#agentDir, "plans");
	}

	/**
	 * Get shell configuration based on settings.
	 */
	getShellConfig() {
		const shell = this.get("shellPath");
		return procmgr.getShellConfig(shell);
	}

	/**
	 * Per-tier raw value lookup. Returns the value at each persisted tier
	 * + the session overrides (undefined when not present at that tier).
	 *
	 * Use this for settings that need additive cross-tier semantics (e.g.
	 * `secrets` — user-tier + project-tier obfuscation patterns BOTH apply).
	 * The default `get()` returns the deep-merged value, in which arrays at
	 * higher tiers REPLACE arrays at lower tiers (intentional for most
	 * settings; wrong for additive lists).
	 */
	getPerTier<P extends SettingPath>(
		path: P,
	): { user: unknown; project: unknown; local: unknown; session: unknown } {
		const segments = parsePath(path);
		return {
			user: getByPath(this.#global, segments),
			project: getByPath(this.#project, segments),
			local: getByPath(this.#local, segments),
			session: getByPath(this.#overrides, segments),
		};
	}

	/**
	 * Get all settings in a group with full type safety.
	 */
	getGroup<G extends GroupPrefix>(prefix: G): GroupTypeMap[G] {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			if (key.startsWith(`${prefix}.`)) {
				const suffix = key.slice(prefix.length + 1);
				result[suffix] = this.get(key);
			}
		}
		return result as unknown as GroupTypeMap[G];
	}

	/**
	 * Get the edit variant for a specific model.
	 * Returns "patch", "replace", "hashline", or null (use global default).
	 */
	getEditVariantForModel(model: string | undefined): EditMode | null {
		if (!model) return null;
		const variants = (this.#merged.edit as { modelVariants?: Record<string, string> })?.modelVariants;
		if (!variants) return null;
		for (const pattern in variants) {
			if (model.includes(pattern)) {
				const value = normalizeEditMode(variants[pattern]);
				if (value) {
					return value;
				}
			}
		}
		return null;
	}

	/**
	 * Get bash interceptor rules (typed accessor for complex array config).
	 */
	getBashInterceptorRules(): BashInterceptorRule[] {
		const patterns = (this.#merged.bashInterceptor as { patterns?: unknown[] })?.patterns;
		if (!Array.isArray(patterns)) return [];

		return patterns.filter((p): p is BashInterceptorRule => typeof p === "object" && p !== null && "pattern" in p);
	}

	/**
	 * Set a model role (helper for modelRoles record).
	 */
	setModelRole(role: ModelRole | string, modelId: string): void {
		const current = this.get("modelRoles");
		this.set("modelRoles", { ...current, [role]: modelId });
	}

	/**
	 * Get a model role (helper for modelRoles record).
	 */
	getModelRole(role: ModelRole | string): string | undefined {
		const roles = this.get("modelRoles");
		return roles[role];
	}

	/**
	 * Get all model roles (helper for modelRoles record).
	 */
	getModelRoles(): ReadOnlyDict<string> {
		return this.get("modelRoles");
	}

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const prev = this.get("modelRoles");
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				prev[role] = modelId;
			}
		}
		this.override("modelRoles", prev);
	}

	/**
	 * Set disabled providers (for compatibility with discovery system).
	 */
	setDisabledProviders(ids: string[]): void {
		this.set("disabledProviders", ids);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Loading
	// ─────────────────────────────────────────────────────────────────────────

				async #load(): Promise<Settings> {
		if (this.#persist) {
			// One-shot legacy YAML/JSON → KDL migration. Runs BEFORE the KDL
			// readers so any translated content is visible on this same launch.
			// Self-contained in src/migration/ — see migration/README.md for the
			// removal contract.
			await maybeRunMigration({
				cwd: this.#cwd,
				agentDir: this.#agentDir,
				userKdlDest: this.#userKdlPath,
				projectKdlDest: this.#projectKdlPath,
				yes: this.#migrateOptions?.yes,
				no: this.#migrateOptions?.no,
				interactive: this.#migrateOptions?.interactive,
			});

			// Open storage
			this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir));
			// Load user settings from user spell.kdl
			this.#global = await loadKdlSettings(this.#userKdlPath);
			// Load local-tier overrides from <cwd>/.local/spell.kdl
			this.#local = await loadKdlSettings(this.#localKdlPath);
		}

		// Load project settings from project-local spell.kdl
		this.#project = await this.#loadProjectSettings();

		// Build merged view
		this.#rebuildMerged();
		this.#fireAllHooks();
		return this;
	}

		async #loadProjectSettings(): Promise<RawSettings> {
		// Spell-owned project config = <cwd>/spell.kdl. Foreign-tool settings
		// (cursor/gemini/etc.) live behind `settingsCapability` and are surfaced
		// via the extension dashboard — they are NOT merged here because their
		// schemas differ from Spell's and silent collisions are unsafe.
		const raw = await loadKdlSettings(this.#projectKdlPath);
		return this.#migrateRawSettings(raw);
	}

	/** Apply schema migrations to raw settings */
	#migrateRawSettings(raw: RawSettings): RawSettings {
		// queueMode -> steeringMode
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}

		// ask.timeout: ms -> seconds (if value > 1000, it's old ms format)
		if (raw.ask && typeof (raw.ask as Record<string, unknown>).timeout === "number") {
			const oldValue = (raw.ask as Record<string, unknown>).timeout as number;
			if (oldValue > 1000) {
				(raw.ask as Record<string, unknown>).timeout = Math.round(oldValue / 1000);
			}
		}

		// Migrate old flat "theme" string to nested theme.dark/theme.light
		if (typeof raw.theme === "string") {
			const oldTheme = raw.theme;
			if (oldTheme === "light" || oldTheme === "dark") {
				// Built-in defaults — just remove, let new defaults apply
				delete raw.theme;
			} else {
				// Custom theme — detect luminance to place in correct slot
				const slot = isLightTheme(oldTheme) ? "light" : "dark";
				raw.theme = { [slot]: oldTheme };
			}
		}

		// task.isolation.enabled (boolean) -> task.isolation.mode (enum)
		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
		if (isolationObj && "enabled" in isolationObj) {
			if (typeof isolationObj.enabled === "boolean") {
				isolationObj.mode = isolationObj.enabled ? "worktree" : "none";
			}
			delete isolationObj.enabled;
		}

		return raw;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Saving
	// ─────────────────────────────────────────────────────────────────────────

	#queueSave(): void {
		if (!this.#persist) return;
		// Debounce: wait 100ms for more changes
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
		}
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			this.#saveNow().catch(err => {
				logger.warn("Settings: background save failed", { error: String(err) });
			});
		}, 100);
	}

		async #saveNow(): Promise<void> {
		await this.#saveTier("user");
		await this.#saveTier("project");
		await this.#saveTier("local");
	}

		async #saveTier(target: PersistTier): Promise<void> {
		const filePath =
			target === "user" ? this.#userKdlPath : target === "project" ? this.#projectKdlPath : this.#localKdlPath;
		const modified =
			target === "user" ? this.#userModified : target === "project" ? this.#projectModified : this.#localModified;
		const source = target === "user" ? this.#global : target === "project" ? this.#project : this.#local;
		if (!this.#persist || !filePath || modified.size === 0) return;
		const modifiedPaths = [...modified];
		modified.clear();
		const changes = new Map<string, unknown>();
		for (const modPath of modifiedPaths) {
			const segments = parsePath(modPath);
			changes.set(modPath, getByPath(source, segments));
		}
		try {
			await writeKdlSettings(filePath, changes);
		} catch (error) {
			logger.warn("Settings: save failed", { target, error: String(error) });
			for (const p of modifiedPaths) {
				modified.add(p);
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

		#rebuildMerged(): void {
		// Read precedence (highest ← lowest): session > local > project > user
		let merged = this.#deepMerge({}, this.#global);
		merged = this.#deepMerge(merged, this.#project);
		merged = this.#deepMerge(merged, this.#local);
		merged = this.#deepMerge(merged, this.#overrides);
		this.#merged = merged;
	}

	#fireAllHooks(): void {
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			const hook = SETTING_HOOKS[key];
			if (hook) {
				const value = this.get(key);
				hook(value, value);
			}
		}
	}

	#deepMerge(base: RawSettings, overrides: RawSettings): RawSettings {
		const result = { ...base };
		for (const key of Object.keys(overrides)) {
			const override = overrides[key];
			const baseVal = base[key];

			if (override === undefined) continue;

			if (
				typeof override === "object" &&
				override !== null &&
				!Array.isArray(override) &&
				typeof baseVal === "object" &&
				baseVal !== null &&
				!Array.isArray(baseVal)
			) {
				result[key] = this.#deepMerge(baseVal as RawSettings, override as RawSettings);
			} else {
				result[key] = override;
			}
		}
		return result;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Setting Hooks
// ═══════════════════════════════════════════════════════════════════════════

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook<any>>> = {
	"theme.dark": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("dark", value);
		}
	},
	"theme.light": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("light", value);
		}
	},
	symbolPreset: value => {
		if (typeof value === "string" && (value === "unicode" || value === "nerd" || value === "ascii")) {
			setSymbolPreset(value).catch(err => {
				logger.warn("Settings: symbolPreset hook failed", { preset: value, error: String(err) });
			});
		}
	},
	colorBlindMode: value => {
		if (typeof value === "boolean") {
			setColorBlindMode(value).catch(err => {
				logger.warn("Settings: colorBlindMode hook failed", { enabled: value, error: String(err) });
			});
		}
	},
	"display.tabWidth": value => {
		if (typeof value === "number") {
			setDefaultTabWidth(value);
		}
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Global Singleton
// ═══════════════════════════════════════════════════════════════════════════

var globalInstance: Settings | null = null;
var globalInstancePromise: Promise<Settings> | null = null;

/**
 * Reset the global singleton for testing.
 * @internal
 */
export function _resetSettingsForTest(): void {
	globalInstance = null;
	globalInstancePromise = null;
}

/**
 * The global settings singleton.
 * Must call `Settings.init()` before using.
 */
export const settings = new Proxy({} as Settings, {
	get(_target, prop) {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		const value = (globalInstance as unknown as Record<string | symbol, unknown>)[prop];
		if (typeof value === "function") {
			return value.bind(globalInstance);
		}
		return value;
	},
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
