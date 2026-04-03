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
import { type EmacsSession, EmacsSessionManager, type EmacsWarmupResult } from "@oh-my-pi/pi-emacs";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { findCategory, findCategoryForId, resolveCategories } from "./categories";
import type { OrgClient } from "./emacs/client";
import { createOrgClient } from "./emacs/client";
import { generateId } from "./id-generator";
import { KeyedMutex } from "./mutex";
import { applyFilter, findItemById, readCategory, readOrgFile, sortItems } from "./org-reader";
import { appendItemToFile, applyItemMutations, initCategoryDir, setPropertyInFile } from "./org-writer";
import { buildOrgQlSexp, parseKeywordQuery, requiresEmacs } from "./query-builder";
import { DEFAULT_ORG_CONFIG, EFFORT_REGEXP, PRIORITY_REGEXP, REQUIRED_PROPERTIES } from "./schema/defaults";
import type {
	CategoryMetrics,
	ComputedWave,
	OrgConfig,
	OrgCreateParams,
	OrgDashboard,
	OrgItem,
	OrgQueryFilter,
	OrgSessionContext,
	ValidationIssue,
} from "./types";

const createCategoryMutex = new KeyedMutex<string>();

// =============================================================================
// Context passed into every command handler
// =============================================================================

interface OrgContext {
	config: OrgConfig;
	projectRoot: string;
	/** Lazily started Emacs session. */
	getEmacsSession(): Promise<EmacsSession>;
	/** Lazily created OrgClient (recreated when the socket path changes). */
	getOrgClient(): Promise<OrgClient>;
	/** Optional session metadata injected into newly created org files. */
	getSessionContext?(): OrgSessionContext;
}

export interface CreateOrgToolOptions {
	emacsSessionFactory?: () => Promise<EmacsSession>;
	emacsSessionManager?: EmacsSessionManager;
	ownsSessionManager?: boolean;
	getSessionContext?: () => OrgSessionContext;
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

/** Expand category directories to individual .org file paths for org-ql. */
async function expandOrgFiles(categories: Array<{ absPath: string }>): Promise<string[]> {
	const fileGroups = await Promise.all(categories.map(async cat => listOrgFilesInDirectory(cat.absPath)));
	return fileGroups.flat();
}

/** Apply limit/offset pagination to a result set. */
function paginateResult(
	items: unknown[],
	totalBeforePagination: number,
	limit?: number,
	offset?: number,
): { items: unknown[]; total: number } {
	let result = items;
	const start = offset && offset > 0 ? offset : 0;
	if (start > 0) result = result.slice(start);
	if (limit !== undefined && limit >= 0) result = result.slice(0, limit);
	return { items: result, total: totalBeforePagination };
}

/** Build a standard mutation response, optionally including the full item or full file text. */
async function buildMutationResponse(
	id: string,
	updated: string[],
	file: string,
	includeBody: boolean | undefined,
	ctx: OrgContext,
	extra?: Record<string, unknown>,
	includeFileContent = false,
): Promise<Record<string, unknown>> {
	const response: Record<string, unknown> = { success: true, id, updated, file, ...extra };
	if (includeFileContent) {
		response.fileContent = await Bun.file(file).text();
	}
	if (includeBody) {
		response.item = await fetchItem(ctx, id);
	}
	return response;
}

/**
 * Normalize literal escape sequences that LLMs produce in body text.
 * By the time the tool receives args, JSON parsing is done — so literal
 * `\n` is genuinely the two characters `\` + `n` in the string value.
 */
export function normalizeOrgBody(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function isToolErrorResult(result: unknown): result is Record<string, unknown> & { error: true; code?: string } {
	if (typeof result !== "object" || result === null || !("error" in result)) {
		return false;
	}

	return (result as Record<string, unknown>).error === true;
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

	const { id, filePath } = await createCategoryMutex.withLock(cat.absPath, async () => {
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

		return { id, filePath };
	});

	logger.debug("org:create", { id, filePath, category: cat.name });

	return {
		success: true,
		id,
		file: filePath,
		category: cat.name,
		state,
	};
}

async function cmdQuery(
	ctx: OrgContext,
	filter: OrgQueryFilter & { query?: string; ql?: string; sort?: string; limit?: number; offset?: number },
): Promise<unknown> {
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
		const files = await expandOrgFiles(targetCats);
		const sortParam = filter.sort ?? "priority todo";
		const result = await client.callTool("org-ql-query", { files, query: filter.ql, sort: sortParam });
		const items = Array.isArray(result) ? result : [];
		return paginateResult(items, items.length, filter.limit, filter.offset);
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
		const files = await expandOrgFiles(targetCats);
		const sexp = buildOrgQlSexp(qlFilter);
		const sortParam = filter.sort ?? "priority todo";
		const result = await client.callTool("org-ql-query", { files, query: sexp, sort: sortParam });
		const items = Array.isArray(result) ? result : [];
		return paginateResult(items, items.length, filter.limit, filter.offset);
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

	const filterWithLevel = { level: 0, ...filter };
	const filtered = applyFilter(allItems, filterWithLevel);
	sortItems(filtered, filter.sort);
	return paginateResult(filtered, filtered.length, filter.limit, filter.offset);
}

async function cmdGet(ctx: OrgContext, args: { id: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	const category = findCategoryForId(categories, args.id);
	if (category) {
		const directPath = path.join(category.absPath, `${args.id}.org`);
		try {
			const items = await readOrgFile({
				filePath: directPath,
				category: category.name,
				dir: category.dirName,
				todoKeywords: ctx.config.todoKeywords,
				includeBody: true,
			});
			const found = items.find(item => item.id === args.id);
			if (found) return { item: found };
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

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
		section?: string;
		title?: string;
		file?: string;
		includeBody?: boolean;
	},
): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);

	if (args.state && !ctx.config.todoKeywords.includes(args.state)) {
		return { error: true, message: `Unknown state: "${args.state}". Valid: ${ctx.config.todoKeywords.join(", ")}` };
	}

	if (args.section !== undefined) {
		if (args.body === undefined && args.append === undefined) {
			return { error: true, message: "update with section requires exactly one of: body, append" };
		}
		if (args.body !== undefined && args.append !== undefined) {
			return { error: true, message: "update with section requires exactly one of: body, append" };
		}
		if (args.state !== undefined || args.title !== undefined || args.note !== undefined) {
			return { error: true, message: "update with section cannot combine state, title, or note" };
		}

		const mode = args.body !== undefined ? "replace" : "append";
		const body = args.body ?? args.append ?? "";
		const updatedField = mode === "replace" ? "body" : "append";
		let targetFile = args.file;
		let client: OrgClient | undefined;

		if (targetFile) {
			client = await ctx.getOrgClient();
			const hintedResult = await client.callTool("org-edit-section", {
				file: targetFile,
				custom_id: args.id,
				section: args.section,
				body,
				mode,
			});
			if (isToolErrorResult(hintedResult)) {
				if (hintedResult.code !== "ITEM_NOT_FOUND") {
					return hintedResult;
				}
				targetFile = undefined;
			} else {
				logger.debug("org:update", {
					id: args.id,
					updated: [updatedField],
					section: args.section,
					file: targetFile,
				});
				return buildMutationResponse(
					args.id,
					[updatedField],
					targetFile,
					args.includeBody,
					ctx,
					{
						section: args.section,
					},
					true,
				);
			}
		}

		if (!targetFile) {
			const item = await fetchItem(ctx, args.id);
			if (!item) {
				return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
			}
			targetFile = item.file;
		}

		client ??= await ctx.getOrgClient();
		const result = await client.callTool("org-edit-section", {
			file: targetFile,
			custom_id: args.id,
			section: args.section,
			body,
			mode,
		});
		if (isToolErrorResult(result)) {
			return result;
		}
		logger.debug("org:update", { id: args.id, updated: [updatedField], section: args.section, file: targetFile });
		return buildMutationResponse(
			args.id,
			[updatedField],
			targetFile,
			args.includeBody,
			ctx,
			{
				section: args.section,
			},
			true,
		);
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
		const allItems = await readCategory(cat.absPath, cat.name, cat.dirName, ctx.config.todoKeywords);
		const topLevelItems = allItems.filter(item => item.level === 0);
		const byState: Record<string, number> = {};

		for (const item of topLevelItems) {
			byState[item.state] = (byState[item.state] ?? 0) + 1;
			totals[item.state] = (totals[item.state] ?? 0) + 1;
			if (item.state === "DOING" || item.state === "REVIEW") inProgress.push(item);
			if (item.state === "BLOCKED") blocked.push(item);
		}

		catMetrics.push({
			category: cat.name,
			prefix: cat.prefix,
			total: topLevelItems.length,
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

/** Collect top-level .org files from a category directory in deterministic order. */
async function listOrgFilesInDirectory(dir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	return entries
		.filter(entry => entry.endsWith(".org") && entry !== "reference.org")
		.sort()
		.map(entry => path.join(dir, entry));
}

async function resolveWaveGraphTargets(
	ctx: OrgContext,
	args: { file?: string; category?: string },
): Promise<Record<string, unknown>> {
	if (args.file) {
		return { file: args.file };
	}

	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	if (args.category) {
		const category = categories.find(cat => cat.name === args.category || cat.prefix === args.category);
		if (!category) {
			return { error: true, message: `Category not found: ${args.category}` };
		}
		return { files: await listOrgFilesInDirectory(category.absPath) };
	}

	const files = (await Promise.all(categories.map(category => listOrgFilesInDirectory(category.absPath))))
		.flat()
		.sort();
	return { files };
}

/** Format computed waves into org-mode Execution Manifest skeleton. */
function formatWaveManifest(waves: ComputedWave[]): string {
	if (waves.length === 0) return "* Execution Manifest\n(No sub-outlines with dependencies found.)\n";
	const lines: string[] = ["* Execution Manifest"];
	for (const wave of waves) {
		const tag = ":wave:";
		const prefix = `** wave-${wave.number}`;
		lines.push(`${prefix}${" ".repeat(Math.max(1, 50 - prefix.length))}${tag}`);
		for (const item of wave.items) {
			lines.push(`- [[id:${item.custom_id}]] ${item.title}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

async function cmdWave(
	ctx: OrgContext,
	args: { file?: string; category?: string; manifest?: boolean },
): Promise<unknown> {
	const client = await ctx.getOrgClient();
	const toolArgs = await resolveWaveGraphTargets(ctx, args);
	if (isToolErrorResult(toolArgs)) return toolArgs;

	if (args.manifest) {
		// Compute waves and generate skeleton Execution Manifest
		const raw = (await client.callTool("org-compute-waves", toolArgs)) as {
			error?: boolean;
			waves?: Array<{ number: number; items: Array<{ custom_id: string; parent_id: string; title: string }> }>;
			warnings?: string[];
			total_sub_outlines?: number;
		};
		if (raw.error) return raw;
		return {
			manifest: formatWaveManifest(raw.waves ?? []),
			waves: raw.waves ?? [],
			warnings: raw.warnings ?? [],
			total_sub_outlines: raw.total_sub_outlines ?? 0,
		};
	}

	return client.callTool("org-next-wave", toolArgs);
}

async function cmdGraph(ctx: OrgContext, args: { file?: string; category?: string }): Promise<unknown> {
	const client = await ctx.getOrgClient();
	const toolArgs = await resolveWaveGraphTargets(ctx, args);
	if (isToolErrorResult(toolArgs)) return toolArgs;
	return client.callTool("org-dependency-graph", toolArgs);
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
	dispose?(): Promise<void> | void;
}

function createWarmupResultFromFactory(factory: () => Promise<EmacsSession>): () => Promise<EmacsWarmupResult> {
	return async () => {
		try {
			const session = await factory();
			if (!session.isAlive()) {
				return {
					status: "error",
					error: "Org Emacs session factory returned a dead session",
					version: undefined,
					session: null,
				};
			}
			return { status: "ready", version: undefined, session };
		} catch (err) {
			return {
				status: "error",
				error: err instanceof Error ? err.message : String(err),
				version: undefined,
				session: null,
			};
		}
	};
}

function resolveOrgSessionManager(options: CreateOrgToolOptions): {
	emacsSessionManager: EmacsSessionManager;
	ownsSessionManager: boolean;
} {
	if (options.emacsSessionManager) {
		return {
			emacsSessionManager: options.emacsSessionManager,
			ownsSessionManager: options.ownsSessionManager ?? false,
		};
	}

	if (!options.emacsSessionFactory) {
		throw new Error("createOrgTool requires either emacsSessionFactory or emacsSessionManager");
	}

	return {
		emacsSessionManager: new EmacsSessionManager({
			startSession: createWarmupResultFromFactory(options.emacsSessionFactory),
		}),
		ownsSessionManager: true,
	};
}

async function closeOrgClient(client: OrgClient | null, context: string): Promise<void> {
	if (!client) return;
	try {
		await client.close();
	} catch (err) {
		logger.warn("org client close failed", {
			context,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Create the org tool bound to a specific project root and config.
 * The returned object is compatible with coding-agent tool registration.
 */
export function createOrgTool(
	projectRoot: string,
	config: OrgConfig = DEFAULT_ORG_CONFIG,
	emacs: (() => Promise<EmacsSession>) | CreateOrgToolOptions,
	getSessionContext?: () => OrgSessionContext,
): OrgToolDefinition {
	const options = typeof emacs === "function" ? { emacsSessionFactory: emacs, getSessionContext } : emacs;
	const { emacsSessionManager, ownsSessionManager } = resolveOrgSessionManager(options);
	let orgClient: OrgClient | null = null;
	let orgClientSocketPath: string | null = null;

	const ctx: OrgContext = {
		config,
		projectRoot,
		async getEmacsSession(): Promise<EmacsSession> {
			const session = await emacsSessionManager.getSession();
			if (!session) {
				throw new Error("org: Emacs session unavailable");
			}
			return session;
		},
		async getOrgClient(): Promise<OrgClient> {
			const session = await ctx.getEmacsSession();
			if (orgClient && orgClientSocketPath === session.socketPath) {
				return orgClient;
			}

			await closeOrgClient(orgClient, "replacing org client for restarted session");
			const client = await createOrgClient(session.socketPath);
			if (!client) {
				throw new Error("socat not found — org-ql transport unavailable");
			}
			orgClient = client;
			orgClientSocketPath = session.socketPath;
			return client;
		},
		getSessionContext: options.getSessionContext,
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
update accepts any combination of: state, body (full replace), append (add to end), title, note (dated note on state change); section-scoped body updates use 'section' with exactly one of body/append via Emacs and cannot combine state/title/note

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
				section: {
					type: "string",
					description: "Target heading (:raw-value) for section-scoped update (update+body/append)",
				},
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
				manifest: {
					type: "boolean",
					description: "Generate skeleton Execution Manifest from computed waves (wave cmd)",
				},
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
						body: normalizeOrgBody(args.body as string | undefined),
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
						sort: args.sort as string | undefined,
						limit: args.limit as number | undefined,
						offset: args.offset as number | undefined,
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
						body: normalizeOrgBody(args.body as string | undefined),
						append: normalizeOrgBody(args.append as string | undefined),
						title: args.title as string | undefined,
						file: args.file as string | undefined,
						section: args.section as string | undefined,
						includeBody: args.includeBody as boolean | undefined,
					});
				}

				case "note": {
					const id = args.id as string | undefined;
					const note = normalizeOrgBody(args.note as string | undefined);
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
					return cmdWave(ctx, {
						file: args.file as string | undefined,
						category: args.category as string | undefined,
						manifest: (args.manifest as boolean | undefined) ?? false,
					});

				case "graph":
					return cmdGraph(ctx, {
						file: args.file as string | undefined,
						category: args.category as string | undefined,
					});

				case "archive":
					return cmdArchive(ctx, { category: args.category as string | undefined });

				default:
					return { error: true, message: `Unknown command: ${command}` };
			}
		},
		async dispose() {
			const client = orgClient;
			orgClient = null;
			orgClientSocketPath = null;
			await closeOrgClient(client, "dispose org tool");
			if (!ownsSessionManager) return;
			try {
				await emacsSessionManager.dispose();
			} catch {
				// Session may have already died or never started.
			}
		},
	};
}
