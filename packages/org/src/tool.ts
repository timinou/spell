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
import { DEFAULT_ORG_CONFIG, EFFORT_REGEXP, PRIORITY_REGEXP, REQUIRED_PROPERTIES } from "./schema/defaults";
import { rewriteSubOutlineIds } from "./sub-outline-rewrite";
import type {
	CategoryMetrics,
	ComputedWave,
	OrgConfig,
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
	validatePlan?: (id: string) => Promise<unknown>;
}

export interface CreateOrgToolOptions {
	getSessionContext?: () => unknown;
	validatePlan?: (id: string) => Promise<unknown>;
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

const STATE_ORDER: Record<string, number> = { INIT: 0, DOING: 1, REVIEW: 2, ITEM: 3, BLOCKED: 4, DONE: 5 };

interface ReadOrgFileOptions {
	filePath: string;
	category: string;
	dir: string;
	todoKeywords: string[];
	includeBody?: boolean;
}

async function readOrgFile(opts: ReadOrgFileOptions): Promise<OrgItem[]> {
	try {
		await fs.stat(opts.filePath);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const result = executeOrg({
		command: "parse",
		file: opts.filePath,
		category: opts.category,
		dir: opts.dir,
		todoKeywords: opts.todoKeywords,
		includeBody: opts.includeBody ?? false,
	});
	if (result.error) {
		try {
			await Bun.file(opts.filePath).text();
		} catch (err) {
			if (isEnoent(err)) return [];
		}
		throw new Error(String(result.output));
	}
	return ((result.output as { items?: OrgItem[] }).items ?? []) as OrgItem[];
}

async function readCategory(
	categoryAbsPath: string,
	category: string,
	dir: string,
	todoKeywords: string[],
	includeBody = false,
): Promise<OrgItem[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(categoryAbsPath);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const orgFiles = entries.filter(entry => entry.endsWith(".org") && entry !== "reference.org");
	const results = await Promise.all(
		orgFiles.map(file =>
			readOrgFile({
				filePath: path.join(categoryAbsPath, file),
				category,
				dir,
				todoKeywords,
				includeBody,
			}),
		),
	);
	return results.flat();
}

function applyFilter(items: OrgItem[], filter: OrgQueryFilter): OrgItem[] {
	return items.filter(item => {
		if (filter.level !== undefined && item.level !== filter.level) return false;
		if (filter.state) {
			const states = Array.isArray(filter.state) ? filter.state : [filter.state];
			if (!states.includes(item.state)) return false;
		}
		if (filter.category) {
			const categories = Array.isArray(filter.category) ? filter.category : [filter.category];
			if (!categories.includes(item.category)) return false;
		}
		if (filter.dir) {
			const dirs = Array.isArray(filter.dir) ? filter.dir : [filter.dir];
			if (!dirs.includes(item.dir)) return false;
		}
		if (filter.priority) {
			const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
			if (!item.properties.PRIORITY || !priorities.includes(item.properties.PRIORITY)) return false;
		}
		if (filter.layer) {
			const layers = Array.isArray(filter.layer) ? filter.layer : [filter.layer];
			if (!item.properties.LAYER || !layers.includes(item.properties.LAYER)) return false;
		}
		if (filter.agent && item.properties.AGENT !== filter.agent) return false;
		return true;
	});
}

function compareByKey(a: OrgItem, b: OrgItem, key: string): number {
	if (key === "priority") {
		const left = a.properties.PRIORITY ? PRIORITY_ORDER.indexOf(a.properties.PRIORITY) : Number.MAX_SAFE_INTEGER;
		const right = b.properties.PRIORITY ? PRIORITY_ORDER.indexOf(b.properties.PRIORITY) : Number.MAX_SAFE_INTEGER;
		return left - right;
	}
	if (key === "state" || key === "todo") return (STATE_ORDER[a.state] ?? 999) - (STATE_ORDER[b.state] ?? 999);
	if (key === "category") return b.category.localeCompare(a.category);
	if (key === "id") return b.id.localeCompare(a.id);
	return 0;
}

function sortItems(items: OrgItem[], sort?: string): OrgItem[] {
	const keys = sort ? sort.split(/\s+/).filter(Boolean) : ["priority", "state", "id"];
	return items.sort((a, b) => {
		for (const key of keys) {
			const cmp = compareByKey(a, b, key);
			if (cmp !== 0) return cmp;
		}
		return 0;
	});
}

async function findItemById(
	categoryDirs: Array<{ absPath: string; name: string; dir: string }>,
	customId: string,
	todoKeywords: string[],
): Promise<OrgItem | undefined> {
	for (const category of categoryDirs) {
		const items = await readCategory(category.absPath, category.name, category.dir, todoKeywords, true);
		const found = items.find(item => item.id === customId);
		if (found) return found;
	}
	return undefined;
}

function buildReferenceOrg(prefix: string, todoKeywords: string[]): string {
	const keywords = todoKeywords.join(" | ");
	return `#+TITLE: Reference\n#+DESCRIPTION: Schema contract for this org directory.\n#+TODO: ${keywords}\n\n* Schema\n\n** Task ID Format\n\nTask IDs follow the pattern: ${prefix}-NNN-kebab-title\nExample: ${prefix}-001-implement-feature\n\n** TODO Keywords\n\n| Keyword | Meaning                            |\n|---------+------------------------------------|\n| ITEM    | Not started                        |\n| DOING   | Actively being worked on           |\n| REVIEW  | Work done, awaiting review         |\n| DONE    | Complete                           |\n| BLOCKED | Waiting on external dependency     |\n`;
}

async function initCategoryDir(categoryAbsPath: string, prefix: string, todoKeywords: string[]): Promise<void> {
	await fs.mkdir(categoryAbsPath, { recursive: true });
	const refPath = path.join(path.dirname(categoryAbsPath), "reference.org");
	try {
		await Bun.file(refPath).text();
	} catch {
		await Bun.write(refPath, buildReferenceOrg(prefix, todoKeywords));
	}
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
	await fs.mkdir(cat.absPath, { recursive: true });
	const session = cat.writeInitialPrompt ? (ctx.getSessionContext?.() as OrgSessionContext | undefined) : undefined;
	const { id, filePath, body } = await createCategoryMutex.withLock(cat.absPath, async () => {
		const id = await generateId(cat.absPath, cat.prefix, args.title);
		const fileName = args.file ? (args.file.endsWith(".org") ? args.file : `${args.file}.org`) : `${id}.org`;
		const filePath = path.join(cat.absPath, fileName);
		const rewrittenBody = args.body === undefined ? undefined : rewriteSubOutlineIds(id, args.body).body;
		const result = executeOrg({
			command: "createItem",
			file: filePath,
			id,
			title: args.title,
			state,
			properties: args.properties,
			body: rewrittenBody,
			sessionId: session?.sessionId,
			transcriptPath: session?.transcriptPath,
			initialMessage: session?.initialMessage,
		});
		if (result.error) throw new Error(String(result.output));
		return { id, filePath, body: rewrittenBody };
	});
	logger.debug("org:create", { id, filePath, category: cat.name });
	return { success: true, id, file: filePath, category: cat.name, state, body, bodyLength: body?.length };
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
	if (args.state && !ctx.config.todoKeywords.includes(args.state)) {
		return { error: true, message: `Unknown state: "${args.state}". Valid: ${ctx.config.todoKeywords.join(", ")}` };
	}
	if (args.section !== undefined) {
		if ((args.body === undefined) === (args.append === undefined)) {
			return { error: true, message: "update with section requires exactly one of: body, append" };
		}
		if (args.state !== undefined || args.title !== undefined || args.note !== undefined) {
			return { error: true, message: "update with section cannot combine state, title, or note" };
		}
		const mode = args.body !== undefined ? "replace" : "append";
		const body = args.body ?? args.append ?? "";
		const trySectionUpdate = async (filePath: string): Promise<Record<string, unknown> | null> => {
			let result: ReturnType<typeof executeOrg>;
			try {
				result = executeOrg({
					command: "editSection",
					file: filePath,
					id: args.id,
					section: args.section,
					body,
					mode,
					todoKeywords: ctx.config.todoKeywords,
				});
			} catch {
				return null;
			}
			if (result.error) return null;
			logger.debug("org:update", { id: args.id, section: args.section, file: filePath });
			return {
				success: true,
				id: args.id,
				updated: [mode === "replace" ? "body" : "append"],
				file: filePath,
				section: args.section,
			};
		};
		if (args.file) {
			const direct = await trySectionUpdate(args.file);
			if (direct) return direct;
		}
		const item = await fetchItem(ctx, args.id);
		if (!item) return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
		return (
			(await trySectionUpdate(item.file)) ?? {
				error: true,
				code: "NOT_FOUND",
				message: `Item not found: ${args.id}`,
			}
		);
	}
	if (!args.state && args.body === undefined && args.append === undefined && !args.title && !args.note) {
		return { error: true, message: "update requires at least one of: state, body, append, title" };
	}
	const rewrittenBody = args.body === undefined ? undefined : rewriteSubOutlineIds(args.id, args.body).body;
	const tryUpdate = async (filePath: string): Promise<Record<string, unknown> | null> => {
		let result: ReturnType<typeof executeOrg>;
		try {
			result = executeOrg({
				command: "updateItem",
				file: filePath,
				id: args.id,
				state: args.state,
				title: args.title,
				body: rewrittenBody,
				append: args.append,
				note: args.note,
				todoKeywords: ctx.config.todoKeywords,
			});
		} catch {
			return null;
		}
		if (result.error) return null;
		const output = result.output as { updated?: string[] };
		return await buildMutationResponse(
			args.id,
			output.updated ?? [],
			filePath,
			args.includeBody,
			ctx,
			undefined,
			args.body !== undefined ? { includeBodyText: true } : args.append !== undefined ? {} : undefined,
		);
	};
	if (args.file) {
		const direct = await tryUpdate(args.file);
		if (direct) return direct;
	}
	for (const cat of categories) {
		let entries: string[];
		try {
			entries = await fs.readdir(cat.absPath);
		} catch {
			continue;
		}
		for (const file of entries.filter(entry => entry.endsWith(".org"))) {
			const filePath = path.join(cat.absPath, file);
			const response = await tryUpdate(filePath);
			if (response) return response;
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
	bodyResponse?: { includeBodyText?: boolean },
): Promise<Record<string, unknown>> {
	const response: Record<string, unknown> = { success: true, id, updated, file, ...extra };
	const item = includeBody || bodyResponse ? await fetchItem(ctx, id) : undefined;
	if (includeBody) response.item = item;
	if (bodyResponse) {
		const finalBody = item?.body ?? "";
		response.bodyLength = finalBody.length;
		if (bodyResponse.includeBodyText) response.body = finalBody;
	}
	return response;
}

async function cmdSet(
	ctx: OrgContext,
	args: { id: string; property: string; value: string; file?: string; includeBody?: boolean },
): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const trySet = async (filePath: string): Promise<Record<string, unknown> | null> => {
		let result: ReturnType<typeof executeOrg>;
		try {
			result = executeOrg({
				command: "setProperty",
				file: filePath,
				id: args.id,
				property: args.property,
				value: args.value,
				todoKeywords: ctx.config.todoKeywords,
			});
		} catch {
			return null;
		}
		if (result.error) return null;
		return {
			success: true,
			id: args.id,
			property: args.property,
			value: args.value,
			file: filePath,
			item: args.includeBody ? await fetchItem(ctx, args.id) : undefined,
		};
	};
	if (args.file) {
		const direct = await trySet(args.file);
		if (direct) return direct;
	}
	for (const cat of categories) {
		let entries: string[];
		try {
			entries = await fs.readdir(cat.absPath);
		} catch {
			continue;
		}
		for (const file of entries.filter(entry => entry.endsWith(".org"))) {
			const filePath = path.join(cat.absPath, file);
			const response = await trySet(filePath);
			if (response) return response;
		}
	}
	return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
}

async function cmdNote(
	ctx: OrgContext,
	args: { id: string; note: string; file?: string; includeBody?: boolean },
): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const tryNote = async (filePath: string): Promise<Record<string, unknown> | null> => {
		let result: ReturnType<typeof executeOrg>;
		try {
			result = executeOrg({
				command: "appendNote",
				file: filePath,
				id: args.id,
				note: args.note,
				todoKeywords: ctx.config.todoKeywords,
			});
		} catch {
			return null;
		}
		if (result.error) return null;
		return await buildMutationResponse(args.id, ["note"], filePath, args.includeBody, ctx);
	};
	if (args.file) {
		const direct = await tryNote(args.file);
		if (direct) return direct;
	}
	for (const cat of categories) {
		let entries: string[];
		try {
			entries = await fs.readdir(cat.absPath);
		} catch {
			continue;
		}
		for (const file of entries.filter(entry => entry.endsWith(".org"))) {
			const filePath = path.join(cat.absPath, file);
			const response = await tryNote(filePath);
			if (response) return response;
		}
	}
	return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
}

async function cmdDelete(ctx: OrgContext, args: { id: string; file?: string }): Promise<unknown> {
	const tryResolveItem = async (filePath: string): Promise<OrgItem | undefined> => {
		try {
			const items = await readOrgFile({
				filePath,
				category: path.basename(path.dirname(filePath)),
				dir: path.basename(path.dirname(filePath)),
				todoKeywords: ctx.config.todoKeywords,
				includeBody: true,
			});
			return items.find(item => item.id === args.id);
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw err;
		}
	};

	const item = (args.file ? await tryResolveItem(args.file) : undefined) ?? (await fetchItem(ctx, args.id));
	if (!item) return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.id}` };
	if (item.state === "DOING" || item.state === "REVIEW") {
		return { error: true, message: `Cannot delete active item ${args.id} while it is ${item.state}` };
	}

	await fs.unlink(item.file);
	return { success: true, id: item.id, file: item.file, deleted: true };
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

async function cmdValidatePlan(ctx: OrgContext, args: { id: string }): Promise<unknown> {
	if (!ctx.validatePlan) {
		return { error: true, message: "validate-plan is not available in this org tool context" };
	}

	return ctx.validatePlan(args.id);
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
		validatePlan: options?.validatePlan,
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
				case "delete":
					return cmdDelete(ctx, {
						id: args.id as string,
						file: args.file as string | undefined,
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
				case "validate-plan":
					return cmdValidatePlan(ctx, { id: args.id as string });
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
