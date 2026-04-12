/**
 * The `org` tool — project management via org-mode files.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeOrg } from "@oh-my-pi/pi-natives";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { findCategory, findCategoryForId, resolveCategories } from "./categories";
import { generateId } from "./id-generator";
import { parseSubOutlineId } from "./id-links";
import { KeyedMutex } from "./mutex";
import { applyFilter, findItemById, readCategory, readOrgFile, sortItems } from "./org-reader";
import { appendItemToFile, applyItemMutations, initCategoryDir, setPropertyInFile } from "./org-writer";
import { DEFAULT_ORG_CONFIG, EFFORT_REGEXP, PRIORITY_REGEXP, REQUIRED_PROPERTIES } from "./schema/defaults";
import type {
	CategoryMetrics,
	ComputedWave,
	OrgConfig,
	OrgCreateParams,
	OrgItem,
	OrgQueryFilter,
	OrgSessionContext,
	ValidationIssue,
} from "./types";

const createCategoryMutex = new KeyedMutex<string>();

interface OrgContext {
	config: OrgConfig;
	projectRoot: string;
	getSessionContext?: () => unknown;
}

export interface CreateOrgToolOptions {
	getSessionContext?: () => unknown;
}

export interface OrgToolDefinition {
	name: string;
	description: string;
	parameters: object;
	execute(args: Record<string, unknown>): Promise<unknown>;
	dispose?(): Promise<void> | void;
}

export function normalizeOrgBody(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

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

const PRIORITY_ORDER = ["#A", "#B", "#C"];

function expandPriorityFilter(op: string, value: string): string[] {
	const idx = PRIORITY_ORDER.indexOf(`#${value}`);
	if (idx === -1) return [`#${value}`];
	switch (op) {
		case ">=":
			return PRIORITY_ORDER.slice(0, idx + 1);
		case "<=":
			return PRIORITY_ORDER.slice(idx);
		case ">":
			return PRIORITY_ORDER.slice(0, idx);
		case "<":
			return PRIORITY_ORDER.slice(idx + 1);
		default:
			return [`#${value}`];
	}
}

function parseKeywordQuery(input: string): OrgQueryFilter {
	const filter: OrgQueryFilter = {};
	for (const token of input.trim().split(/\s+/)) {
		if (!token) continue;
		if (token.startsWith("todo:")) filter.state = token.slice(5).split(",").filter(Boolean);
		else if (token.startsWith("priority:")) {
			const val = token.slice(9);
			const match = /^(>=|<=|>|<|=)?#?([A-C])$/i.exec(val);
			if (match) {
				const op = match[1] ?? "=";
				filter.priority = expandPriorityFilter(op, match[2]!.toUpperCase());
			}
		} else if (token.startsWith("property:")) {
			const [key, value] = token.slice(9).split("=", 2);
			if (key && value !== undefined) {
				if (key.toUpperCase() === "LAYER") filter.layer = value;
				if (key.toUpperCase() === "AGENT") filter.agent = value;
			}
		}
	}

	return filter;
}

async function fetchItem(ctx: OrgContext, id: string): Promise<OrgItem | undefined> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	return findItemById(
		categories.map(c => ({ absPath: c.absPath, name: c.name, dir: c.dirName })),
		id,
		ctx.config.todoKeywords,
	);
}

async function cmdInit(ctx: OrgContext, args: { category?: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const targets = args.category
		? ([findCategory(categories, args.category)].filter(Boolean) as typeof categories)
		: categories;
	if (targets.length === 0) return { error: true, message: `Category not found: ${args.category}` };
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
	if (!catName) return { error: true, message: "No categories configured" };
	const cat = findCategory(categories, catName);
	if (!cat)
		return {
			error: true,
			message: `Category not found: "${catName}". Known: ${categories.map(c => c.name).join(", ")}`,
		};
	const state = args.state ?? ctx.config.todoKeywords[0] ?? "ITEM";
	if (!ctx.config.todoKeywords.includes(state))
		return { error: true, message: `Unknown state: "${state}". Valid: ${ctx.config.todoKeywords.join(", ")}` };
	await fs.mkdir(cat.absPath, { recursive: true });
	const { id, filePath } = await createCategoryMutex.withLock(cat.absPath, async () => {
		const id = await generateId(cat.absPath, cat.prefix, args.title);
		const fileName = args.file ? (args.file.endsWith(".org") ? args.file : `${args.file}.org`) : `${id}.org`;
		const filePath = path.join(cat.absPath, fileName);
		await appendItemToFile(
			filePath,
			{
				title: args.title,
				category: catName,
				state,
				id,
				properties: args.properties,
				body: args.body,
				file: args.file,
			} as OrgCreateParams & { id: string },
			state,
			cat.writeInitialPrompt ? (ctx.getSessionContext?.() as OrgSessionContext | undefined) : undefined,
		);
		return { id, filePath };
	});
	logger.debug("org:create", { id, filePath, category: cat.name });
	return { success: true, id, file: filePath, category: cat.name, state };
}

async function cmdQuery(
	ctx: OrgContext,
	filter: OrgQueryFilter & { query?: string; ql?: string; sort?: string; limit?: number; offset?: number },
): Promise<unknown> {
	if (filter.ql) return { error: true, message: "raw sexp queries are no longer supported" };
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const targetCats = filter.category
		? categories.filter(
				c =>
					(Array.isArray(filter.category) ? filter.category : [filter.category]).includes(c.name) ||
					(Array.isArray(filter.category) ? filter.category : [filter.category]).includes(c.prefix),
			)
		: categories;
	const parsed = filter.query ? parseKeywordQuery(filter.query) : {};
	const merged: OrgQueryFilter = { ...parsed, ...filter };
	if (parsed.state && !filter.state) merged.state = parsed.state;
	if (parsed.priority && !filter.priority) merged.priority = parsed.priority;
	if (parsed.layer && !filter.layer) merged.layer = parsed.layer;
	if (parsed.agent && !filter.agent) merged.agent = parsed.agent;
	const allItems: OrgItem[] = [];
	await Promise.all(
		targetCats.map(async cat =>
			allItems.push(
				...(await readCategory(
					cat.absPath,
					cat.name,
					cat.dirName,
					ctx.config.todoKeywords,
					filter.includeBody ?? false,
				)),
			),
		),
	);
	const filtered = applyFilter(allItems, { level: 0, ...merged });
	sortItems(filtered, filter.sort);
	return paginateResult(filtered, filtered.length, filter.limit, filter.offset);
}

async function cmdGet(ctx: OrgContext, args: { id: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const category = findCategoryForId(categories, args.id);
	if (category) {
		const subOutline = parseSubOutlineId(args.id);
		const fileBaseName = subOutline ? subOutline.parentId : args.id;
		try {
			const items = await readOrgFile({
				filePath: path.join(category.absPath, `${fileBaseName}.org`),
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
	return item ? { item } : { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
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
	if (args.state && !ctx.config.todoKeywords.includes(args.state))
		return { error: true, message: `Unknown state: "${args.state}". Valid: ${ctx.config.todoKeywords.join(", ")}` };
	if (args.section !== undefined) {
		if ((args.body === undefined) === (args.append === undefined))
			return { error: true, message: "update with section requires exactly one of: body, append" };
		if (args.state !== undefined || args.title !== undefined || args.note !== undefined)
			return { error: true, message: "update with section cannot combine state, title, or note" };
		const mode = args.body !== undefined ? "replace" : "append";
		const body = args.body ?? args.append ?? "";
		let targetFile = args.file;
		if (!targetFile) {
			const item = await fetchItem(ctx, args.id);
			if (!item) return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
			targetFile = item.file;
		}
		const source = await Bun.file(targetFile).text();
		const result = executeOrg({ command: "editSection", source, section: args.section, body, mode });
		if (result.error) return result.output;
		await Bun.write(
			targetFile,
			String(
				(result.output as { source?: string; text?: string; markdown?: string }).source ??
					(result.output as { source?: string }).source ??
					source,
			),
		);
		logger.debug("org:update", { id: args.id, section: args.section, file: targetFile });
		return {
			success: true,
			id: args.id,
			updated: [mode === "replace" ? "body" : "append"],
			file: targetFile,
			section: args.section,
		};
	}
	if (!args.state && args.body === undefined && args.append === undefined && !args.title)
		return { error: true, message: "update requires at least one of: state, body, append, title" };
	const mutations = { state: args.state, title: args.title, body: args.body, append: args.append, note: args.note };
	if (args.file) {
		const result = await applyItemMutations(args.file, args.id, mutations, ctx.config.todoKeywords);
		if (result !== null) return await buildMutationResponse(args.id, result, args.file, args.includeBody, ctx);
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
			const result = await applyItemMutations(filePath, args.id, mutations, ctx.config.todoKeywords);
			if (result !== null && result.length > 0)
				return await buildMutationResponse(args.id, result, filePath, args.includeBody, ctx);
		}
	}
	return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
}

async function buildMutationResponse(
	id: string,
	updated: string[],
	file: string,
	includeBody: boolean | undefined,
	ctx: OrgContext,
	extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const response: Record<string, unknown> = { success: true, id, updated, file, ...extra };
	if (includeBody) response.item = await fetchItem(ctx, id);
	return response;
}

async function cmdSet(
	ctx: OrgContext,
	args: { id: string; property: string; value: string; file?: string; includeBody?: boolean },
): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	if (args.file) {
		const updated = await setPropertyInFile(args.file, args.id, args.property, args.value);
		if (updated)
			return {
				success: true,
				id: args.id,
				property: args.property,
				value: args.value,
				file: args.file,
				item: args.includeBody ? await fetchItem(ctx, args.id) : undefined,
			};
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
			if (await setPropertyInFile(filePath, args.id, args.property, args.value)) {
				return {
					success: true,
					id: args.id,
					property: args.property,
					value: args.value,
					file: filePath,
					item: args.includeBody ? await fetchItem(ctx, args.id) : undefined,
				};
			}
		}
	}
	return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
}

async function cmdNote(
	ctx: OrgContext,
	args: { id: string; note: string; file?: string; includeBody?: boolean },
): Promise<unknown> {
	const dated = `NOTE [${new Date().toISOString().slice(0, 10)}]: ${args.note}`;
	return cmdUpdate(ctx, { id: args.id, append: dated, file: args.file, includeBody: args.includeBody });
}

async function cmdDashboard(ctx: OrgContext): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const catMetrics: CategoryMetrics[] = [];
	const totals: Record<string, number> = {};
	for (const kw of ctx.config.todoKeywords) totals[kw] = 0;
	const inProgress: OrgItem[] = [];
	const blocked: OrgItem[] = [];
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
		catMetrics.push({ category: cat.name, prefix: cat.prefix, total: topLevelItems.length, byState });
	}
	return { root: ctx.projectRoot, categories: catMetrics, totals, inProgress, blocked };
}

async function cmdValidate(ctx: OrgContext, args: { category?: string; file?: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const targets = args.category ? categories.filter(c => c.name === args.category) : categories;
	const issues: ValidationIssue[] = [];
	for (const cat of targets) {
		const items = await readCategory(cat.absPath, cat.name, cat.dirName, ctx.config.todoKeywords);
		for (const item of items) {
			for (const prop of REQUIRED_PROPERTIES)
				if (!item.properties[prop])
					issues.push({
						severity: "error",
						rule: "required-property",
						message: `Missing required property: ${prop}`,
						hint: `Add :${prop}: to the PROPERTIES drawer`,
						file: item.file,
						line: item.line,
					});
			if (item.properties.EFFORT && !EFFORT_REGEXP.test(item.properties.EFFORT))
				issues.push({
					severity: "warning",
					rule: "effort-format",
					message: `Invalid EFFORT format: ${item.properties.EFFORT}`,
					hint: "Use format Xh or Xm (e.g. 2h, 30m)",
					file: item.file,
					line: item.line,
				});
			if (item.properties.PRIORITY && !PRIORITY_REGEXP.test(item.properties.PRIORITY))
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
	return {
		valid: issues.filter(i => i.severity === "error").length === 0,
		errors: issues.filter(i => i.severity === "error"),
		warnings: issues.filter(i => i.severity === "warning"),
	};
}

async function collectItems(ctx: OrgContext, args: { file?: string; category?: string }): Promise<OrgItem[]> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	if (args.file) {
		const item = await readOrgFile({
			filePath: args.file,
			category: path.basename(path.dirname(args.file)),
			dir: path.basename(path.dirname(args.file)),
			todoKeywords: ctx.config.todoKeywords,
			includeBody: false,
		});
		return item;
	}
	const targets = args.category
		? categories.filter(cat => cat.name === args.category || cat.prefix === args.category)
		: categories;
	const items: OrgItem[] = [];
	for (const cat of targets)
		items.push(...(await readCategory(cat.absPath, cat.name, cat.dirName, ctx.config.todoKeywords)));
	return items;
}

function formatWaveManifest(waves: ComputedWave[]): string {
	if (waves.length === 0) return "* Execution Manifest\n(No sub-outlines with dependencies found.)\n";
	const lines: string[] = ["* Execution Manifest"];
	for (const wave of waves) {
		lines.push(`** wave-${wave.number}`);
		for (const item of wave.items) lines.push(`- [[id:${item.custom_id}]] ${item.title}`);
	}
	lines.push("");
	return lines.join("\n");
}

async function cmdWave(
	ctx: OrgContext,
	args: { file?: string; category?: string; manifest?: boolean },
): Promise<unknown> {
	const items = await collectItems(ctx, args);
	const raw = executeOrg({ command: args.manifest ? "computeWaves" : "nextWave", items, doneStates: ["DONE"] });
	if (raw.error) return raw.output;
	if (args.manifest) {
		const output = raw.output as { waves?: ComputedWave[]; warnings?: string[]; total_sub_outlines?: number };
		return {
			manifest: formatWaveManifest(output.waves ?? []),
			waves: output.waves ?? [],
			warnings: output.warnings ?? [],
			total_sub_outlines: output.total_sub_outlines ?? 0,
		};
	}
	return raw.output;
}

async function cmdGraph(ctx: OrgContext, args: { file?: string; category?: string }): Promise<unknown> {
	const items = await collectItems(ctx, args);
	const raw = executeOrg({ command: "graph", items });
	return raw.output;
}

async function cmdArchive(ctx: OrgContext, args: { category?: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const targets = args.category ? categories.filter(c => c.name === args.category) : categories;
	const archived: Array<{ id: string; file: string }> = [];
	for (const cat of targets) {
		const items = await readCategory(cat.absPath, cat.name, cat.dirName, ctx.config.todoKeywords);
		for (const item of items.filter(i => i.state === "DONE")) archived.push({ id: item.id, file: item.file });
	}
	return { archived: archived.length, items: archived };
}

export function createOrgTool(
	projectRoot: string,
	config: OrgConfig = DEFAULT_ORG_CONFIG,
	options?: CreateOrgToolOptions,
): OrgToolDefinition {
	const ctx: OrgContext = {
		config,
		projectRoot,
		getSessionContext: options?.getSessionContext as (() => OrgSessionContext) | undefined,
	};
	return {
		name: "org",
		description: `Org-mode project management. Subcommands:\n  init        Initialize org directories and category subdirs\n  create      Create a new task item (ID auto-generated)\n  query       List/filter items (state, category, priority, layer, or keyword query)\n  get         Get single item by ID with full body\n  update      Change state, body, title, or append text (any combo in one call)\n  note        Append a dated NOTE entry to an item (no state change)\n  set         Set a single PROPERTIES drawer value\n  validate    Validate items\n  dashboard   Project metrics and in-progress/blocked summary\n  wave        Next wave of ready items by priority\n  graph       Dependency graph\n  archive     Archive DONE items\n`,
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
				},
			},
			required: ["command"],
		},
		async execute(args: Record<string, unknown>): Promise<unknown> {
			const command = args.command as string;
			switch (command) {
				case "init":
					return cmdInit(ctx, { category: args.category as string | undefined });
				case "create":
					return cmdCreate(ctx, {
						title: args.title as string,
						category: args.category as string | undefined,
						state: args.state as string | undefined,
						properties: args.properties as Record<string, string> | undefined,
						body: normalizeOrgBody(args.body as string | undefined),
						file: args.file as string | undefined,
					});
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
				case "get":
					return cmdGet(ctx, { id: args.id as string });
				case "update":
					return cmdUpdate(ctx, {
						id: args.id as string,
						state: args.state as string | undefined,
						note: args.note as string | undefined,
						body: normalizeOrgBody(args.body as string | undefined),
						append: normalizeOrgBody(args.append as string | undefined),
						title: args.title as string | undefined,
						file: args.file as string | undefined,
						section: args.section as string | undefined,
						includeBody: args.includeBody as boolean | undefined,
					});
				case "note":
					return cmdNote(ctx, {
						id: args.id as string,
						note: normalizeOrgBody(args.note as string | undefined) ?? "",
						file: args.file as string | undefined,
						includeBody: args.includeBody as boolean | undefined,
					});
				case "set":
					return cmdSet(ctx, {
						id: args.id as string,
						property: args.property as string,
						value: args.value as string,
						file: args.file as string | undefined,
						includeBody: args.includeBody as boolean | undefined,
					});
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
			// No-op: native engine has no persistent state to clean up.
		},
	};
}
