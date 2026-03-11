/**
 * Default schema values for the org system.
 *
 * These are the out-of-box settings applied when the user has not configured
 * an org section in .omp/config.yml.
 */

import type { OrgConfig } from "../types";

/** TODO keywords in order of typical progression. */
export const DEFAULT_TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"] as const;

/** Terminal states — items in these states are considered complete. */
export const TERMINAL_STATES = new Set(["DONE"]);

/** Blocked states — items in these states are stuck. */
export const BLOCKED_STATES = new Set(["BLOCKED"]);

/** In-progress states — actively being worked on. */
export const ACTIVE_STATES = new Set(["DOING", "REVIEW"]);

/**
 * Valid state transitions.
 * Key = current state, Value = allowed next states.
 */
export const STATE_TRANSITIONS: Record<string, readonly string[]> = {
	ITEM: ["DOING", "BLOCKED"],
	DOING: ["REVIEW", "BLOCKED", "DONE"],
	REVIEW: ["DOING", "DONE", "BLOCKED"],
	DONE: [],
	BLOCKED: ["ITEM", "DOING"],
};

/** Properties required on every task heading (validation ERROR if missing). */
export const REQUIRED_PROPERTIES = ["CUSTOM_ID", "EFFORT", "PRIORITY"] as const;

/** Properties recommended on task headings (validation WARNING if missing). */
export const RECOMMENDED_PROPERTIES = ["DEPENDS", "BLOCKS", "FILES", "TEST_PLAN", "LAYER"] as const;

/** Optional properties (validation INFO if missing). */
export const OPTIONAL_PROPERTIES = ["BLAST_RADIUS", "FEATURE_FLAG", "RESEARCH_REF", "AGENT"] as const;

/** Regexp for valid EFFORT format: number + unit (h/m). E.g. "2h", "30m". */
export const EFFORT_REGEXP = /^[0-9]+[hm]$/;

/** Regexp for valid PRIORITY format: #A, #B, or #C. */
export const PRIORITY_REGEXP = /^#[ABC]$/;

/** Regexp for valid CUSTOM_ID format: PREFIX-NUM or PREFIX-NUM-slug. */
export const CUSTOM_ID_REGEXP = /^[A-Z]+-\d+(-[a-z0-9-]+)?$/;

/** Valid LAYER values. */
export const VALID_LAYERS = ["backend", "frontend", "data", "prompt", "infra", "test", "docs"] as const;

/** Default org configuration used when none is present in .omp/config.yml. */
export const DEFAULT_ORG_CONFIG: OrgConfig = {
	dirs: {
		tasks: {
			path: "!tasks",
			agent: "task",
			categories: {
				projects: { prefix: "PROJ", path: "projects" },
				features: { prefix: "FEAT", path: "features" },
				bugs: { prefix: "BUG", path: "bugs" },
				drafts: { prefix: "DRAFT", path: "drafts" },
			},
		},
	},
	todoKeywords: [...DEFAULT_TODO_KEYWORDS],
	requiredProperties: [...REQUIRED_PROPERTIES],
};
