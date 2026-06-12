/**
 * Default schema values for the org system.
 *
 * These are the out-of-box settings applied when the user has not configured
 * an org section in .spell/config.yml.
 */

import type { OrgConfig } from "../types";

/** TODO keywords in order of typical progression. */
export const DEFAULT_TODO_KEYWORDS = ["INIT", "ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"] as const;

/** Terminal states — items in these states are considered complete. */
export const TERMINAL_STATES = new Set(["DONE"]);

/** Blocked states — items in these states are stuck. */
export const BLOCKED_STATES = new Set(["BLOCKED"]);

/** In-progress states — actively being worked on. */
export const ACTIVE_STATES = new Set(["INIT", "DOING", "REVIEW"]);

/**
 * Valid state transitions.
 * Key = current state, Value = allowed next states.
 */
export const STATE_TRANSITIONS: Record<string, readonly string[]> = {
	INIT: ["DOING", "REVIEW", "BLOCKED"],
	ITEM: ["DOING", "BLOCKED"],
	DOING: ["REVIEW", "BLOCKED", "DONE"],
	REVIEW: ["DOING", "DONE", "BLOCKED"],
	DONE: [],
	BLOCKED: ["INIT", "ITEM", "DOING"],
};

/** Properties required on every task heading (validation ERROR if missing). */
export const REQUIRED_PROPERTIES = ["CUSTOM_ID"] as const;

/** Properties recommended on task headings (validation WARNING if missing). */
export const RECOMMENDED_PROPERTIES = ["DEPENDS", "BLOCKS", "FILES", "TEST_PLAN", "LAYER"] as const;

/** Optional properties (validation INFO if missing). */
export const OPTIONAL_PROPERTIES = ["BLAST_RADIUS", "FEATURE_FLAG", "RESEARCH_REF", "AGENT"] as const;

/** Regexp for valid CUSTOM_ID format: PREFIX-NUM, PREFIX-NUM-slug, or PREFIX-NUM::sub-slug. */
export const CUSTOM_ID_REGEXP = /^[A-Z]+-\d+(-[a-z0-9-]+)?(::[a-z0-9-]+)?$/;

/** Regexp for valid WAVE format: single integer. */
export const WAVE_REGEXP = /^[0-9]+$/;

/** Regexp for valid WAVES summary format: comma-separated integers. */
export const WAVES_REGEXP = /^[0-9]+(,[0-9]+)*$/;

/** Valid LAYER values. */
export const VALID_LAYERS = ["backend", "frontend", "data", "prompt", "infra", "test", "docs"] as const;

/** Default org configuration used when none is present in .spell/config.yml. */
export const DEFAULT_ORG_CONFIG: OrgConfig = {
	dirs: {
		tasks: {
			path: "!tasks",
			agent: "task",
			categories: {
				plans: { prefix: "PLAN", path: "plans" },
				projects: { prefix: "PROJ", path: "projects" },
				features: { prefix: "FEAT", path: "features" },
				bugs: { prefix: "BUG", path: "bugs" },
				followups: { prefix: "FUP", path: "follow-ups" },
				drafts: { prefix: "DRAFT", path: "drafts" },
				audits: { prefix: "AUD", path: "audits" },
				// Stored-program tiles (FUP-123): a tile = a queryable org item whose
				// PROPERTIES drawer holds its config (owner/project/program_ref/mode/
				// autoWrite/schedule + a cached last-outcome). Run history lives as
				// memory episodes, not in the org body.
				tiles: { prefix: "TILE", path: "tiles" },
			},
		},
		sessions: {
			path: "!sessions",
			categories: {
				sessions: { prefix: "SESS", path: "sessions", writeInitialPrompt: false },
			},
		},
	},
	todoKeywords: [...DEFAULT_TODO_KEYWORDS],
	requiredProperties: [...REQUIRED_PROPERTIES],
};
