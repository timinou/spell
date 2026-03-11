/**
 * The `org` tool — project management via org-mode files.
 *
 * Single tool with subcommands. Basic operations work without Emacs;
 * advanced operations (validate, wave, graph, dashboard) use the Emacs bridge
 * when available.
 *
 * This module exports a factory that takes the project root and org config,
 * and returns an AgentTool-compatible definition object suitable for
 * registration in the coding-agent sdk.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { findCategory, findCategoryForId, resolveCategories } from "./categories";
import type { EmacsSession } from "./emacs/daemon";
import { generateId } from "./id-generator";
import { applyFilter, findItemById, readCategory } from "./org-reader";
import { appendItemToFile, initCategoryDir, setPropertyInFile, updateItemStateInFile } from "./org-writer";
import { DEFAULT_ORG_CONFIG, EFFORT_REGEXP, PRIORITY_REGEXP, REQUIRED_PROPERTIES } from "./schema/defaults";
import type {
	CategoryMetrics,
	OrgConfig,
	OrgCreateParams,
	OrgDashboard,
	OrgItem,
	OrgQueryFilter,
	ValidationIssue,
} from "./types";

// =============================================================================
// Context passed into every command handler
// =============================================================================

interface OrgContext {
	config: OrgConfig;
	projectRoot: string;
	/** Lazily started Emacs session (null if Emacs unavailable or not yet started). */
	getEmacsSession(): Promise<EmacsSession | null>;
}

// =============================================================================
// Command implementations
// =============================================================================

async function cmdInit(ctx: OrgContext, args: { category?: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	const targets = args.category
		? ([findCategory(categories, args.category)].filter(Boolean) as typeof categories)
		: categories;

	if (targets.length === 0) {
		return { error: true, message: `Category not found: ${args.category}` };
	}

	const results: Array<{ category: string; absPath: string; created: boolean }> = [];

	for (const cat of targets) {
		const existed = await fs
			.stat(cat.absPath)
			.then(() => true)
			.catch(() => false);
		await initCategoryDir(cat.absPath, cat.prefix, ctx.config.todoKeywords);
		results.push({ category: cat.name, absPath: cat.absPath, created: !existed });
	}

	return { success: true, initialized: results };
}

async function cmdCreate(
	ctx: OrgContext,
	args: {
		title: string;
		category: string;
		state?: string;
		properties?: Record<string, string>;
		body?: string;
		file?: string;
	},
): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const cat = findCategory(categories, args.category);

	if (!cat) {
		return {
			error: true,
			message: `Category not found: "${args.category}". Known: ${categories.map(c => c.name).join(", ")}`,
		};
	}

	const state = args.state ?? ctx.config.todoKeywords[0] ?? "ITEM";

	if (!ctx.config.todoKeywords.includes(state)) {
		return { error: true, message: `Unknown state: "${state}". Valid: ${ctx.config.todoKeywords.join(", ")}` };
	}

	// Ensure directory exists
	await fs.mkdir(cat.absPath, { recursive: true });

	// Generate ID
	const id = await generateId(cat.absPath, cat.prefix, args.title);

	// Determine target file
	const fileName = args.file ? (args.file.endsWith(".org") ? args.file : `${args.file}.org`) : `${id}.org`;
	const filePath = path.join(cat.absPath, fileName);

	const params: OrgCreateParams & { id: string } = {
		title: args.title,
		category: args.category,
		state,
		id,
		properties: args.properties,
		body: args.body,
		file: args.file,
	};

	await appendItemToFile(filePath, params, state);

	logger.debug("org:create", { id, filePath, category: cat.name });

	return {
		success: true,
		id,
		file: filePath,
		category: cat.name,
		state,
	};
}

async function cmdQuery(ctx: OrgContext, filter: OrgQueryFilter): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const allItems: OrgItem[] = [];

	// Determine which categories to scan
	const targetCats = filter.category
		? categories.filter(c => {
				const cats = Array.isArray(filter.category) ? filter.category! : [filter.category!];
				return cats.includes(c.name) || cats.includes(c.prefix);
			})
		: categories;

	await Promise.all(
		targetCats.map(async cat => {
			const items = await readCategory(
				cat.absPath,
				cat.name,
				cat.dirName,
				ctx.config.todoKeywords,
				filter.includeBody ?? false,
			);
			allItems.push(...items);
		}),
	);

	const filtered = applyFilter(allItems, filter);
	return { items: filtered, total: filtered.length };
}

async function cmdGet(ctx: OrgContext, args: { id: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	// Try Emacs first for fidelity
	const session = await ctx.getEmacsSession();
	if (session) {
		try {
			// Find which category owns this ID
			const cat = findCategoryForId(categories, args.id);
			if (cat) {
				// Call Emacs tool to get item with body
				// (Emacs path stubbed — falls through to TS reader)
			}
		} catch (err) {
			logger.debug("org:get emacs fallback", { error: String(err) });
		}
	}

	// TS-based fallback
	const item = await findItemById(
		categories.map(c => ({ absPath: c.absPath, name: c.name, dir: c.dirName })),
		args.id,
		ctx.config.todoKeywords,
	);

	if (!item) {
		return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
	}

	return { item };
}

async function cmdUpdate(ctx: OrgContext, args: { id: string; state: string; note?: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	if (!ctx.config.todoKeywords.includes(args.state)) {
		return { error: true, message: `Unknown state: "${args.state}". Valid: ${ctx.config.todoKeywords.join(", ")}` };
	}

	// Try Emacs for state machine enforcement
	const session = await ctx.getEmacsSession();
	if (session) {
		// Emacs-backed update path not yet wired; falls through to TS path
	}

	// TS-based path: scan category files to find the item
	for (const cat of categories) {
		let entries: string[];
		try {
			entries = await fs.readdir(cat.absPath);
		} catch {
			continue;
		}

		for (const file of entries.filter(e => e.endsWith(".org"))) {
			const filePath = path.join(cat.absPath, file);
			const updated = await updateItemStateInFile(filePath, args.id, args.state, ctx.config.todoKeywords, args.note);
			if (updated) {
				logger.debug("org:update", { id: args.id, state: args.state });
				return { success: true, id: args.id, state: args.state, file: filePath };
			}
		}
	}

	return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
}

async function cmdSet(ctx: OrgContext, args: { id: string; property: string; value: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	for (const cat of categories) {
		let entries: string[];
		try {
			entries = await fs.readdir(cat.absPath);
		} catch {
			continue;
		}

		for (const file of entries.filter(e => e.endsWith(".org"))) {
			const filePath = path.join(cat.absPath, file);
			const updated = await setPropertyInFile(filePath, args.id, args.property, args.value);
			if (updated) {
				return { success: true, id: args.id, property: args.property, value: args.value };
			}
		}
	}

	return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
}

async function cmdDashboard(ctx: OrgContext): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	// Try Emacs for full metrics
	const session = await ctx.getEmacsSession();
	if (session) {
		// Emacs-backed dashboard not yet wired; falls through to TS basic path
	}

	// TS-based basic dashboard
	const catMetrics: CategoryMetrics[] = [];
	const totals: Record<string, number> = {};
	const inProgress: OrgItem[] = [];
	const blocked: OrgItem[] = [];

	for (const kw of ctx.config.todoKeywords) {
		totals[kw] = 0;
	}

	for (const cat of categories) {
		const items = await readCategory(cat.absPath, cat.name, cat.dirName, ctx.config.todoKeywords);
		const byState: Record<string, number> = {};

		for (const item of items) {
			byState[item.state] = (byState[item.state] ?? 0) + 1;
			totals[item.state] = (totals[item.state] ?? 0) + 1;
			if (item.state === "DOING" || item.state === "REVIEW") inProgress.push(item);
			if (item.state === "BLOCKED") blocked.push(item);
		}

		catMetrics.push({
			category: cat.name,
			prefix: cat.prefix,
			total: items.length,
			byState,
		});
	}

	const dashboard: OrgDashboard = {
		root: ctx.projectRoot,
		categories: catMetrics,
		totals,
		inProgress,
		blocked,
	};

	return dashboard;
}

async function cmdValidate(ctx: OrgContext, args: { category?: string; file?: string }): Promise<unknown> {
	// Validation requires Emacs for full org-element AST
	const session = await ctx.getEmacsSession();
	if (!session) {
		// Basic TS validation — check required properties
		const categories = resolveCategories(ctx.config, ctx.projectRoot);
		const targets = args.category ? categories.filter(c => c.name === args.category) : categories;

		const issues: ValidationIssue[] = [];

		for (const cat of targets) {
			const items = await readCategory(cat.absPath, cat.name, cat.dirName, ctx.config.todoKeywords);
			for (const item of items) {
				for (const prop of REQUIRED_PROPERTIES) {
					if (!item.properties[prop]) {
						issues.push({
							severity: "error",
							rule: "required-property",
							message: `Missing required property: ${prop}`,
							hint: `Add :${prop}: to the PROPERTIES drawer`,
							file: item.file,
							line: item.line,
						});
					}
				}
				if (item.properties.EFFORT && !EFFORT_REGEXP.test(item.properties.EFFORT)) {
					issues.push({
						severity: "warning",
						rule: "effort-format",
						message: `Invalid EFFORT format: ${item.properties.EFFORT}`,
						hint: "Use format Xh or Xm (e.g. 2h, 30m)",
						file: item.file,
						line: item.line,
					});
				}
				if (item.properties.PRIORITY && !PRIORITY_REGEXP.test(item.properties.PRIORITY)) {
					issues.push({
						severity: "warning",
						rule: "priority-format",
						message: `Invalid PRIORITY: ${item.properties.PRIORITY}`,
						hint: "Use #A, #B, or #C",
						file: item.file,
						line: item.line,
					});
				}
			}
		}

		const errors = issues.filter(i => i.severity === "error");
		const warnings = issues.filter(i => i.severity === "warning");
		return {
			valid: errors.length === 0,
			errors,
			warnings,
			note: "Basic validation only — Emacs not available for full AST validation",
		};
	}

	// Emacs-backed full validation would go here
	return { valid: true, errors: [], warnings: [], note: "Emacs validation not yet wired" };
}

async function cmdWave(ctx: OrgContext): Promise<unknown> {
	const session = await ctx.getEmacsSession();
	if (!session) {
		return {
			error: true,
			message: "wave requires Emacs (dependency graph resolution). Install Emacs >= 29.1 and socat.",
		};
	}
	// Emacs wave call
	return { error: true, message: "Emacs wave not yet wired" };
}

async function cmdGraph(ctx: OrgContext): Promise<unknown> {
	const session = await ctx.getEmacsSession();
	if (!session) {
		return {
			error: true,
			message: "graph requires Emacs for dependency resolution.",
		};
	}
	return { error: true, message: "Emacs graph not yet wired" };
}

async function cmdArchive(ctx: OrgContext, args: { category?: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const targets = args.category ? categories.filter(c => c.name === args.category) : categories;

	const archived: Array<{ id: string; file: string }> = [];

	for (const cat of targets) {
		const items = await readCategory(cat.absPath, cat.name, cat.dirName, ctx.config.todoKeywords);
		const done = items.filter(i => i.state === "DONE");

		if (done.length === 0) continue;

		const archiveDir = path.join(cat.dirAbsPath, "archive");
		await fs.mkdir(archiveDir, { recursive: true });

		// Group by source file — we'll move the entire item text
		for (const item of done) {
			// Simple approach: note the item as archived (full move is complex without Emacs)
			archived.push({ id: item.id, file: item.file });
		}
	}

	return {
		archived: archived.length,
		items: archived,
		note: "Full archive move requires Emacs. Items noted for manual archive.",
	};
}

// =============================================================================
// Tool factory
// =============================================================================

export interface OrgToolDefinition {
	name: string;
	description: string;
	parameters: object;
	execute(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Create the org tool bound to a specific project root and config.
 * The returned object is compatible with coding-agent tool registration.
 */
export function createOrgTool(
	projectRoot: string,
	config: OrgConfig = DEFAULT_ORG_CONFIG,
	/** Optional factory for an Emacs session (provided by the Emacs bridge). */
	emacsSessionFactory?: () => Promise<EmacsSession | null>,
): OrgToolDefinition {
	// Lazy Emacs session — started only on first advanced query
	let emacsSessionPromise: Promise<EmacsSession | null> | null = null;

	const ctx: OrgContext = {
		config,
		projectRoot,
		getEmacsSession(): Promise<EmacsSession | null> {
			if (!emacsSessionFactory) return Promise.resolve(null);
			if (!emacsSessionPromise) {
				emacsSessionPromise = emacsSessionFactory().catch(err => {
					logger.warn("org: Emacs session failed to start", { error: String(err) });
					return null;
				});
			}
			return emacsSessionPromise;
		},
	};

	return {
		name: "org",
		description: `Org-mode project management. Subcommands:
  init        Initialize org directories and category subdirs
  create      Create a new task item (ID auto-generated)
  query       List/filter items (state, category, priority, layer)
  get         Get single item by ID with full body
  update      Change item TODO state
  set         Set a property on an item
  validate    Validate items (requires Emacs for full AST validation)
  dashboard   Project metrics and in-progress/blocked summary
  wave        Next wave of ready items by priority (requires Emacs)
  graph       Dependency graph (requires Emacs)
  archive     Archive DONE items

Task IDs are auto-generated: PREFIX-NNN-kebab-title (e.g. PROJ-042-auth-refactor)`,
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					enum: [
						"init",
						"create",
						"query",
						"get",
						"update",
						"set",
						"validate",
						"dashboard",
						"wave",
						"graph",
						"archive",
					],
					description: "Subcommand to execute",
				},
				// create params
				title: { type: "string", description: "Item title (for create)" },
				category: { type: "string", description: "Category name or prefix" },
				state: { type: "string", description: "TODO state" },
				properties: { type: "object", description: "Properties map" },
				body: { type: "string", description: "Item body text" },
				file: { type: "string", description: "Target file basename (optional)" },
				// query params
				dir: { type: "string", description: "Org dir filter" },
				priority: { type: "string", description: "Priority filter (#A/#B/#C)" },
				layer: { type: "string", description: "Layer filter" },
				agent: { type: "string", description: "Agent filter" },
				includeBody: { type: "boolean", description: "Include body text in query results" },
				// get/update/set params
				id: { type: "string", description: "Task CUSTOM_ID" },
				note: { type: "string", description: "Note to append on state change" },
				property: { type: "string", description: "Property name (for set)" },
				value: { type: "string", description: "Property value (for set)" },
			},
			required: ["command"],
		},
		async execute(args: Record<string, unknown>): Promise<unknown> {
			const command = args.command as string;

			switch (command) {
				case "init":
					return cmdInit(ctx, { category: args.category as string | undefined });

				case "create": {
					const title = args.title as string | undefined;
					if (!title) return { error: true, message: "create requires title" };
					const cat = args.category as string | undefined;
					if (!cat) return { error: true, message: "create requires category" };
					return cmdCreate(ctx, {
						title,
						category: cat,
						state: args.state as string | undefined,
						properties: args.properties as Record<string, string> | undefined,
						body: args.body as string | undefined,
						file: args.file as string | undefined,
					});
				}

				case "query":
					return cmdQuery(ctx, {
						state: args.state as string | string[] | undefined,
						category: args.category as string | string[] | undefined,
						dir: args.dir as string | string[] | undefined,
						priority: args.priority as string | string[] | undefined,
						layer: args.layer as string | string[] | undefined,
						agent: args.agent as string | undefined,
						includeBody: args.includeBody as boolean | undefined,
					});

				case "get": {
					const id = args.id as string | undefined;
					if (!id) return { error: true, message: "get requires id" };
					return cmdGet(ctx, { id });
				}

				case "update": {
					const id = args.id as string | undefined;
					const state = args.state as string | undefined;
					if (!id) return { error: true, message: "update requires id" };
					if (!state) return { error: true, message: "update requires state" };
					return cmdUpdate(ctx, { id, state, note: args.note as string | undefined });
				}

				case "set": {
					const id = args.id as string | undefined;
					const property = args.property as string | undefined;
					const value = args.value as string | undefined;
					if (!id) return { error: true, message: "set requires id" };
					if (!property) return { error: true, message: "set requires property" };
					if (value === undefined) return { error: true, message: "set requires value" };
					return cmdSet(ctx, { id, property, value });
				}

				case "validate":
					return cmdValidate(ctx, {
						category: args.category as string | undefined,
						file: args.file as string | undefined,
					});

				case "dashboard":
					return cmdDashboard(ctx);

				case "wave":
					return cmdWave(ctx);

				case "graph":
					return cmdGraph(ctx);

				case "archive":
					return cmdArchive(ctx, { category: args.category as string | undefined });

				default:
					return { error: true, message: `Unknown command: ${command}` };
			}
		},
	};
}
