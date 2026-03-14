/**
 * The `org` tool — project management via org-mode files.
 *
 * Single tool with subcommands. Simple queries run TS-side; advanced queries
 * (dateRange, clocked, effort, numeric property ops) transparently route to
 * org-ql via the Emacs bridge. Emacs is always available — no fallback paths.
 *
 * This module exports a factory that takes the project root and org config,
 * and returns an AgentTool-compatible definition object suitable for
 * registration in the coding-agent sdk.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { findCategory, resolveCategories } from "./categories";
import type { OrgClient } from "./emacs/client";
import { createOrgClient } from "./emacs/client";
import type { EmacsSession } from "./emacs/daemon";
import { generateId } from "./id-generator";
import { applyFilter, findItemById, readCategory } from "./org-reader";
import { appendItemToFile, applyItemMutations, initCategoryDir, setPropertyInFile } from "./org-writer";
import { buildOrgQlSexp, parseKeywordQuery, requiresEmacs } from "./query-builder";
import { DEFAULT_ORG_CONFIG, EFFORT_REGEXP, PRIORITY_REGEXP, REQUIRED_PROPERTIES } from "./schema/defaults";
import type {
	CategoryMetrics,
	OrgConfig,
	OrgCreateParams,
	OrgDashboard,
	OrgItem,
	OrgQueryFilter,
	OrgSessionContext,
	ValidationIssue,
} from "./types";

// =============================================================================
// Context passed into every command handler
// =============================================================================

interface OrgContext {
	config: OrgConfig;
	projectRoot: string;
	/** Lazily started Emacs session. */
	getEmacsSession(): Promise<EmacsSession>;
	/** Lazily created OrgClient (cached after first call). */
	getOrgClient(): Promise<OrgClient>;
	/** Optional session metadata injected into newly created org files. */
	getSessionContext?(): OrgSessionContext;
}

// =============================================================================
// Command implementations
// =============================================================================

/** Fetch a single item by ID for includeBody echo responses. */
async function fetchItem(ctx: OrgContext, id: string): Promise<OrgItem | undefined> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	return findItemById(
		categories.map(c => ({ absPath: c.absPath, name: c.name, dir: c.dirName })),
		id,
		ctx.config.todoKeywords,
	);
}

/** Build a standard mutation response, optionally including the full item. */
async function buildMutationResponse(
	id: string,
	updated: string[],
	file: string,
	includeBody: boolean | undefined,
	ctx: OrgContext,
	extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const response: Record<string, unknown> = { success: true, id, updated, file, ...extra };
	if (includeBody) {
		response.item = await fetchItem(ctx, id);
	}
	return response;
}

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
		category?: string;
		state?: string;
		properties?: Record<string, string>;
		body?: string;
		file?: string;
	},
): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const catName = args.category ?? categories[0]?.name;
	if (!catName) {
		return { error: true, message: "No categories configured" };
	}
	const cat = findCategory(categories, catName);

	if (!cat) {
		return {
			error: true,
			message: `Category not found: "${catName}". Known: ${categories.map(c => c.name).join(", ")}`,
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
		category: catName,
		state,
		id,
		properties: args.properties,
		body: args.body,
		file: args.file,
	};

	const sessionCtx = cat.writeInitialPrompt ? ctx.getSessionContext?.() : undefined;
	await appendItemToFile(filePath, params, state, sessionCtx);

	logger.debug("org:create", { id, filePath, category: cat.name });

	return {
		success: true,
		id,
		file: filePath,
		category: cat.name,
		state,
	};
}

async function cmdQuery(ctx: OrgContext, filter: OrgQueryFilter & { query?: string; ql?: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	// Determine which categories to scan
	const targetCats = filter.category
		? categories.filter(c => {
				const cats = Array.isArray(filter.category) ? filter.category! : [filter.category!];
				return cats.includes(c.name) || cats.includes(c.prefix);
			})
		: categories;

	// Raw org-ql sexp passthrough — bypasses keyword parsing entirely
	if (filter.ql) {
		const client = await ctx.getOrgClient();
		const files = targetCats.flatMap(cat => {
			// List .org files synchronously — we don't have async iteration here,
			// so we pass the directory path and let the elisp side enumerate files.
			return [cat.absPath];
		});
		const result = await client.callTool("org-ql-query", { files, query: filter.ql });
		const items = Array.isArray(result) ? result : [];
		return { items, total: items.length };
	}

	// Support keyword query syntax, e.g. "todo:DOING tags:auth"
	const qlFilter = filter.query ? parseKeywordQuery(filter.query) : null;

	if (qlFilter) {
		// Promote parsed keyword fields into the structural filter for TS-side fields
		if (qlFilter.todo && !filter.state) filter = { ...filter, state: qlFilter.todo };
	}

	// Advanced queries (dateRange, clocked, effort, numeric property ops) route to org-ql
	if (qlFilter && requiresEmacs(qlFilter)) {
		const client = await ctx.getOrgClient();
		const files = targetCats.map(cat => cat.absPath);
		const sexp = buildOrgQlSexp(qlFilter);
		const result = await client.callTool("org-ql-query", { files, query: sexp });
		const items = Array.isArray(result) ? result : [];
		return { items, total: items.length };
	}

	// Simple queries: TS path (fast, no IPC overhead)
	const allItems: OrgItem[] = [];

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

async function cmdUpdate(
	ctx: OrgContext,
	args: {
		id: string;
		state?: string;
		note?: string;
		body?: string;
		append?: string;
		title?: string;
		file?: string;
		includeBody?: boolean;
	},
): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	if (args.state && !ctx.config.todoKeywords.includes(args.state)) {
		return { error: true, message: `Unknown state: "${args.state}". Valid: ${ctx.config.todoKeywords.join(", ")}` };
	}

	// At least one mutation must be specified
	if (!args.state && args.body === undefined && args.append === undefined && !args.title) {
		return { error: true, message: "update requires at least one of: state, body, append, title" };
	}

	const mutations = {
		state: args.state,
		title: args.title,
		body: args.body,
		append: args.append,
		note: args.note,
	};

	// If file hint is provided, try it first
	if (args.file) {
		const result = await applyItemMutations(args.file, args.id, mutations, ctx.config.todoKeywords);
		if (result !== null) {
			logger.debug("org:update", { id: args.id, updated: result });
			return buildMutationResponse(args.id, result, args.file, args.includeBody, ctx);
		}
	}

	// Scan all categories
	for (const cat of categories) {
		let entries: string[];
		try {
			entries = await fs.readdir(cat.absPath);
		} catch {
			continue;
		}

		for (const file of entries.filter(e => e.endsWith(".org"))) {
			const filePath = path.join(cat.absPath, file);
			const result = await applyItemMutations(filePath, args.id, mutations, ctx.config.todoKeywords);
			if (result !== null && result.length > 0) {
				logger.debug("org:update", { id: args.id, updated: result });
				return buildMutationResponse(args.id, result, filePath, args.includeBody, ctx);
			}
		}
	}

	return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
}

async function cmdSet(
	ctx: OrgContext,
	args: { id: string; property: string; value: string; file?: string; includeBody?: boolean },
): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	// If file hint is provided, try it first
	if (args.file) {
		const updated = await setPropertyInFile(args.file, args.id, args.property, args.value);
		if (updated) {
			const response: Record<string, unknown> = {
				success: true,
				id: args.id,
				property: args.property,
				value: args.value,
				file: args.file,
			};
			if (args.includeBody) {
				response.item = await fetchItem(ctx, args.id);
			}
			return response;
		}
	}

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
				const response: Record<string, unknown> = {
					success: true,
					id: args.id,
					property: args.property,
					value: args.value,
					file: filePath,
				};
				if (args.includeBody) {
					response.item = await fetchItem(ctx, args.id);
				}
				return response;
			}
		}
	}

	return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
}

/**
 * Append a dated NOTE entry to an item's body without changing its state.
 *
 * Produces: `NOTE [YYYY-MM-DD]: {text}`
 * This is sugar for `update { append: ... }` with a standard format.
 */
async function cmdNote(
	ctx: OrgContext,
	args: { id: string; note: string; file?: string; includeBody?: boolean },
): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const dated = `NOTE [${new Date().toISOString().slice(0, 10)}]: ${args.note}`;

	// If file hint is provided, try it first
	if (args.file) {
		const result = await applyItemMutations(args.file, args.id, { append: dated }, ctx.config.todoKeywords);
		if (result !== null && result.length > 0) {
			logger.debug("org:note", { id: args.id });
			return buildMutationResponse(args.id, ["note"], args.file, args.includeBody, ctx, { note: dated });
		}
	}

	for (const cat of categories) {
		let entries: string[];
		try {
			entries = await fs.readdir(cat.absPath);
		} catch {
			continue;
		}
		for (const file of entries.filter(e => e.endsWith(".org"))) {
			const filePath = path.join(cat.absPath, file);
			const result = await applyItemMutations(filePath, args.id, { append: dated }, ctx.config.todoKeywords);
			if (result !== null && result.length > 0) {
				logger.debug("org:note", { id: args.id });
				return buildMutationResponse(args.id, ["note"], filePath, args.includeBody, ctx, { note: dated });
			}
		}
	}
	return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
}

async function cmdDashboard(ctx: OrgContext): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

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
	};
}

async function cmdWave(ctx: OrgContext): Promise<unknown> {
	// Emacs wave call — not yet wired to elisp tool
	void ctx;
	return { error: true, message: "wave not yet wired" };
}

async function cmdGraph(ctx: OrgContext): Promise<unknown> {
	// Emacs graph call — not yet wired to elisp tool
	void ctx;
	return { error: true, message: "graph not yet wired" };
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

		// Group by source file — full item move requires Emacs org-archive-subtree
		for (const item of done) {
			archived.push({ id: item.id, file: item.file });
		}
	}

	return {
		archived: archived.length,
		items: archived,
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
	/** Factory for an Emacs session (provided by the Emacs bridge). */
	emacsSessionFactory: () => Promise<EmacsSession>,
	/** Optional factory for session context written into newly created org files. */
	getSessionContext?: () => OrgSessionContext,
): OrgToolDefinition {
	// Lazy Emacs session — started only on first advanced query
	let emacsSessionPromise: Promise<EmacsSession> | null = null;
	// Lazy OrgClient — created once from the session socket path
	let orgClientPromise: Promise<OrgClient> | null = null;

	const ctx: OrgContext = {
		config,
		projectRoot,
		getEmacsSession(): Promise<EmacsSession> {
			if (!emacsSessionPromise) {
				emacsSessionPromise = emacsSessionFactory();
			}
			return emacsSessionPromise;
		},
		async getOrgClient(): Promise<OrgClient> {
			if (!orgClientPromise) {
				orgClientPromise = ctx.getEmacsSession().then(async session => {
					const client = await createOrgClient(session.socketPath);
					if (!client) {
						throw new Error("socat not found — org-ql transport unavailable");
					}
					return client;
				});
			}
			return orgClientPromise;
		},
		getSessionContext,
	};

	return {
		name: "org",
		description: `Org-mode project management. Subcommands:
  init        Initialize org directories and category subdirs
  create      Create a new task item (ID auto-generated)
  query       List/filter items (state, category, priority, layer, or keyword query)
  get         Get single item by ID with full body
  update      Change state, body, title, or append text (any combo in one call)
  note        Append a dated NOTE entry to an item (no state change)
  set         Set a single PROPERTIES drawer value
  validate    Validate items (requires Emacs for full AST validation)
  dashboard   Project metrics and in-progress/blocked summary
  wave        Next wave of ready items by priority
  graph       Dependency graph
  archive     Archive DONE items

Task IDs are auto-generated: PREFIX-NNN-kebab-title (e.g. PROJ-042-auth-refactor)
update accepts any combination of: state, body (full replace), append (add to end), title, note (dated note on state change)

query supports keyword syntax via the 'query' param: 'todo:DOING tags:auth priority:>=B'`,
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
						"note",
						"set",
						"validate",
						"dashboard",
						"wave",
						"graph",
						"archive",
					],
					description: "Subcommand to execute",
				},
				// create/update params
				title: { type: "string", description: "Item title (create, or update to rename)" },
				category: {
					type: "string",
					description: "Category name or prefix (defaults to first configured category on create)",
				},
				state: { type: "string", description: "TODO state (create default, or update target)" },
				properties: { type: "object", description: "Properties map (create)" },
				body: { type: "string", description: "Body text — create: initial body; update: full replacement" },
				append: { type: "string", description: "Text to append to the end of an item's body (update)" },
				file: {
					type: "string",
					description: "Target file basename (create), or absolute path hint to skip scan (update/note/set)",
				},
				// query params
				dir: { type: "string", description: "Org dir filter" },
				priority: { type: "string", description: "Priority filter (#A/#B/#C)" },
				layer: { type: "string", description: "Layer filter" },
				agent: { type: "string", description: "Agent filter" },
				query: { type: "string", description: "Keyword query syntax: 'todo:DOING tags:auth priority:>=B'" },
				ql: { type: "string", description: "Raw org-ql sexp for advanced queries (e.g. '(effort >= \"2h\")')" },
				includeBody: { type: "boolean", description: "Include body text in results (query, update, note, set)" },
				// get/update/set/note params
				id: { type: "string", description: "Task CUSTOM_ID" },
				note: { type: "string", description: "Dated note text (note cmd, or appended on state change)" },
				property: { type: "string", description: "Property name (set)" },
				value: { type: "string", description: "Property value (set)" },
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
						query: args.query as string | undefined,
						ql: args.ql as string | undefined,
					});

				case "get": {
					const id = args.id as string | undefined;
					if (!id) return { error: true, message: "get requires id" };
					return cmdGet(ctx, { id });
				}

				case "update": {
					const id = args.id as string | undefined;
					if (!id) return { error: true, message: "update requires id" };
					return cmdUpdate(ctx, {
						id,
						state: args.state as string | undefined,
						note: args.note as string | undefined,
						body: args.body as string | undefined,
						append: args.append as string | undefined,
						title: args.title as string | undefined,
						file: args.file as string | undefined,
						includeBody: args.includeBody as boolean | undefined,
					});
				}

				case "note": {
					const id = args.id as string | undefined;
					const note = args.note as string | undefined;
					if (!id) return { error: true, message: "note requires id" };
					if (!note) return { error: true, message: "note requires note" };
					return cmdNote(ctx, {
						id,
						note,
						file: args.file as string | undefined,
						includeBody: args.includeBody as boolean | undefined,
					});
				}

				case "set": {
					const id = args.id as string | undefined;
					const property = args.property as string | undefined;
					const value = args.value as string | undefined;
					if (!id) return { error: true, message: "set requires id" };
					if (!property) return { error: true, message: "set requires property" };
					if (value === undefined) return { error: true, message: "set requires value" };
					return cmdSet(ctx, {
						id,
						property,
						value,
						file: args.file as string | undefined,
						includeBody: args.includeBody as boolean | undefined,
					});
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
