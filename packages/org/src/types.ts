/**
 * Core types for the Pi org system.
 *
 * Two-level hierarchy:
 *   OrgDir    — top-level folder (e.g. !tasks/)
 *   OrgCategory — sub-directory with a prefix (e.g. projects/ → PROJ)
 *
 * Task IDs: {PREFIX}-{padded-num}-kebab-title  (e.g. PROJ-042-auth-refactor)
 */

// =============================================================================
// Configuration types
// =============================================================================

export interface OrgCategoryConfig {
	/** Short uppercase prefix used in task IDs (e.g. "PROJ"). */
	prefix: string;
	/** Sub-directory path relative to the containing org dir. */
	path: string;
	/** Default agent for items in this category (overrides dir default). */
	agent?: string;
	/**
	 * When true (default), newly created .org files in this category embed the
	 * agent system prompt in an `* Initial Prompt` section, plus `#+SESSION_ID:`
	 * and `#+TRANSCRIPT_PATH:` in the file frontmatter.
	 */
	writeInitialPrompt?: boolean;
}

export interface OrgDirConfig {
	/** Filesystem path relative to project root (e.g. "!tasks"). */
	path: string;
	/** Default agent for items in this directory. */
	agent?: string;
	/** Named categories within this directory. */
	categories: Record<string, OrgCategoryConfig>;
}

export interface OrgConfig {
	/** Named org directories. Keys are logical names (e.g. "tasks"). */
	dirs: Record<string, OrgDirConfig>;
	/** Absolute path to emacs binary. Auto-detected when empty. */
	emacsPath?: string;
	/** TODO keywords recognised in org files. */
	todoKeywords: string[];
	/** Properties every task heading must have. */
	requiredProperties: string[];
}

// =============================================================================
// Resolved category (config + resolved absolute paths)
// =============================================================================

export interface OrgCategory {
	/** Logical dir name (e.g. "tasks"). */
	dirName: string;
	/** Logical category name (e.g. "projects"). */
	name: string;
	/** Uppercase prefix for IDs (e.g. "PROJ"). */
	prefix: string;
	/** Absolute filesystem path to this category directory. */
	absPath: string;
	/** Absolute path to the containing org dir. */
	dirAbsPath: string;
	/** Default agent. */
	agent?: string;
	/**
	 * When true (default), newly created .org files in this category embed the
	 * agent system prompt plus session metadata.
	 */
	writeInitialPrompt: boolean;
}

/**
 * Session metadata passed into `appendItemToFile` when creating a new file.
 * Each field is optional; only present fields are written.
 */
export interface OrgSessionContext {
	/** Agent session identifier written as `#+SESSION_ID:`. */
	sessionId?: string;
	/** Absolute path to the JSONL session transcript, written as an org-mode file link. */
	transcriptPath?: string;
	/** Full agent system prompt written into an `* Initial Prompt` heading. */
	systemPrompt?: string;
}

// =============================================================================
// Task / item types
// =============================================================================

/** Validation severity for a property or state issue. */
export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
	severity: ValidationSeverity;
	rule: string;
	message: string;
	hint?: string;
	/** Absolute file path */
	file?: string;
	line?: number;
}

export interface OrgItem {
	/** Unique task ID (e.g. "PROJ-042-auth-refactor"). */
	id: string;
	/** Heading title (without TODO keyword or tags). */
	title: string;
	/** TODO state (e.g. "ITEM", "DOING"). */
	state: string;
	/** Category this item belongs to. */
	category: string;
	/** Org dir this item belongs to. */
	dir: string;
	/** Absolute path to the .org file containing this item. */
	file: string;
	/** 1-indexed line number of the heading. */
	line: number;
	/** Heading level (1 = top-level). */
	level: number;
	/** All properties extracted from the PROPERTIES drawer. */
	properties: Record<string, string>;
	/** Body text below the heading (excluding property drawer). */
	body?: string;
	/** Nested sub-items (populated when requested). */
	children?: OrgItem[];
}

// =============================================================================
// Dashboard / metrics
// =============================================================================

export interface CategoryMetrics {
	category: string;
	prefix: string;
	total: number;
	byState: Record<string, number>;
}

export interface OrgDashboard {
	/** Project root (cwd). */
	root: string;
	/** Per-category metrics. */
	categories: CategoryMetrics[];
	/** Totals across all categories. */
	totals: Record<string, number>;
	/** Items currently DOING. */
	inProgress: OrgItem[];
	/** Items that are BLOCKED. */
	blocked: OrgItem[];
}

// =============================================================================
// Query filters
// =============================================================================

export interface OrgQueryFilter {
	/** Filter by state(s). */
	state?: string | string[];
	/** Filter by category name(s). */
	category?: string | string[];
	/** Filter by dir name(s). */
	dir?: string | string[];
	/** Filter by PRIORITY property value(s) (e.g. "#A"). */
	priority?: string | string[];
	/** Filter by LAYER property value(s). */
	layer?: string | string[];
	/** Filter by AGENT property. */
	agent?: string;
	/** Include item body in results. Default false. */
	includeBody?: boolean;
}

// =============================================================================
// Create / update parameters
// =============================================================================

export interface OrgCreateParams {
	/** Title of the new item. Used to derive the kebab slug. */
	title: string;
	/** Category to create in (logical name, e.g. "projects"). */
	category: string;
	/** Initial TODO state. Default: first keyword. */
	state?: string;
	/** Properties to set on creation. */
	properties?: Record<string, string>;
	/** Body text. */
	body?: string;
	/**
	 * Target file (basename without extension) within the category.
	 * If omitted, Pi creates a file named after the kebab slug.
	 */
	file?: string;
}

export interface OrgUpdateParams {
	/** Task ID (CUSTOM_ID) to update. */
	id: string;
	/** New TODO state. */
	state: string;
	/** Optional note appended to the item body. */
	note?: string;
}

export interface OrgSetPropertyParams {
	/** Task ID (CUSTOM_ID). */
	id: string;
	/** Property name (uppercase). */
	property: string;
	/** New value. */
	value: string;
}
