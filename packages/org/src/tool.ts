/**
 * The `org` tool — project management via org-mode files.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeOrg } from "@spell/pi-natives";
import { isEnoent, logger } from "@spell/pi-utils";
import { findCategory, resolveCategories } from "./categories";
import { generateId } from "./id-generator";
import { extractIdLinks, parseSubOutlineId } from "./id-links";
import { KeyedMutex } from "./mutex";
import { DEFAULT_ORG_CONFIG, REQUIRED_PROPERTIES } from "./schema/defaults";
import { rewriteSubOutlineIds } from "./sub-outline-rewrite";
import type {
	ComputedWave,
	ComputedWaveResult,
	OrgConfig,
	OrgDag,
	OrgItem,
	OrgQueryFilter,
	OrgSessionContext,
	ValidationIssue,
} from "./types";

const createCategoryMutex = new KeyedMutex<string>();
const SUBOUTLINE_SLUG_RE = /^[A-Za-z0-9_-]+$/;
const TOP_LEVEL_HEADING_RE = /^\*\s+/m;
const CUSTOM_ID_IN_BODY_RE = /^\s*:CUSTOM_ID:\s+(\S+)\s*$/gm;

function collectSameParentSuboutlineIds(parentId: string, body: string): Set<string> {
	const ids = new Set<string>();
	for (const match of body.matchAll(CUSTOM_ID_IN_BODY_RE)) {
		const customId = match[1];
		if (!customId) continue;
		const parsed = parseSubOutlineId(customId);
		if (parsed?.parentId === parentId) ids.add(customId);
	}
	return ids;
}

function buildSuboutlineBlock(args: {
	parentId: string;
	slug: string;
	title: string;
	body?: string;
	depends?: string[];
	layer?: string;
}): string {
	const heading =
		args.title.match(/^(?:(?:TODO|ITEM|DOING|REVIEW|DONE|BLOCKED|CANCELLED)\b\s+)?(.*)$/)?.[1]?.trim() ?? args.title;
	const lines = [
		`** ${args.title.match(/^(?:TODO|ITEM|DOING|REVIEW|DONE|BLOCKED|CANCELLED)\b/) ? args.title : `ITEM ${heading}`}`,
		":PROPERTIES:",
		`:CUSTOM_ID: ${args.parentId}::${args.slug}`,
	];
	if ((args.depends?.length ?? 0) > 0) lines.push(`:DEPENDS: ${args.depends!.join(" ")}`);
	if (args.layer) lines.push(`:LAYER: ${args.layer}`);
	lines.push(":END:");
	if (args.body) lines.push(args.body);
	return lines.join("\n");
}

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

const STATE_ORDER: Record<string, number> = {
	INIT: 0,
	DOING: 1,
	REVIEW: 2,
	ITEM: 3,
	BLOCKED: 4,
	DONE: 5,
};

interface ReadOrgFileOptions {
	filePath: string;
	category: string;
	dir: string;
	todoKeywords: string[];
	includeBody?: boolean;
}

async function readOrgFile(opts: ReadOrgFileOptions): Promise<OrgItem[]> {
	const result = await executeOrg({
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

function compareOrgItemLocation(a: OrgItem, b: OrgItem): number {
	const fileCmp = a.file.localeCompare(b.file);
	if (fileCmp !== 0) return fileCmp;
	const lineCmp = a.line - b.line;
	if (lineCmp !== 0) return lineCmp;
	return a.id.localeCompare(b.id);
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

async function fetchItems(ctx: OrgContext, id: string, includeBody = true): Promise<OrgItem[]> {
	const result = await executeOrg({
		command: "orgIndexResolve",
		root: ctx.projectRoot,
		categories: indexCategories(ctx),
		todoKeywords: ctx.config.todoKeywords,
		id,
		includeBody,
	});
	if (result.error) throw new Error(String(result.output));
	return ((result.output as { items?: OrgItem[] }).items ?? []) as OrgItem[];
}

async function fetchItem(ctx: OrgContext, id: string): Promise<OrgItem | undefined> {
	return (await fetchItems(ctx, id))[0];
}
/**
 * Maximum distinct candidate IDs surfaced in an AMBIGUOUS_ID error before the
 * list is truncated. Keeps the agent-facing message bounded.
 */
const MAX_ID_CANDIDATES = 10;

/**
 * Maps each id-bearing org command to the argument key that carries a
 * CUSTOM_ID. Commands absent from this map (create/query/init/dashboard/...) do
 * not take an id and bypass implicit resolution entirely.
 */
const ID_ARG_BY_COMMAND: Record<string, string> = {
	get: "id",
	update: "id",
	delete: "id",
	note: "id",
	set: "id",
	"validate-plan": "id",
	"suboutline-add": "parentId",
	wave: "planItemId",
};

type IdResolution =
	| { ok: true; id: string; warning?: string }
	| { ok: false; error: true; code: "AMBIGUOUS_ID"; message: string; candidates: string[] };

/**
 * Resolve a possibly-partial CUSTOM_ID against the org index (FEAT: implicit
 * prefix resolution). An exact hit wins immediately. Otherwise the id is
 * treated as a `startsWith` prefix over every indexed item:
 *   - 0 matches  -> returned unchanged; the downstream command emits its own
 *                   NOT_FOUND so behaviour is identical to today.
 *   - 1 match    -> resolved to the canonical id with a `warning` advising the
 *                   caller to pass the full id (or use `query`) next time.
 *   - >1 matches -> short-circuit AMBIGUOUS_ID listing the conflicting ids so
 *                   the caller can disambiguate.
 */
async function resolveImplicitId(ctx: OrgContext, rawId: string): Promise<IdResolution> {
	// Common path: exact id present in the index (cheap native filter).
	const exact = await fetchItems(ctx, rawId, false);
	if (exact.length > 0) return { ok: true, id: rawId };

	// Fall back to a prefix scan over the full (already in-memory) index.
	const all = await indexedList(ctx, { includeBody: false });
	const candidates = [...new Set(all.filter(item => item.id.startsWith(rawId)).map(item => item.id))].sort();

	if (candidates.length === 0) return { ok: true, id: rawId };
	if (candidates.length === 1) {
		return {
			ok: true,
			id: candidates[0] as string,
			warning: `Resolved "${rawId}" -> "${candidates[0]}" by prefix. Pass the full ID or use \`query\` to avoid this.`,
		};
	}
	const shown = candidates.slice(0, MAX_ID_CANDIDATES);
	const suffix = candidates.length > shown.length ? ` (+${candidates.length - shown.length} more)` : "";
	return {
		ok: false,
		error: true,
		code: "AMBIGUOUS_ID",
		message: `"${rawId}" matches ${candidates.length} items: ${shown.join(", ")}${suffix}. Pass the full ID or use \`query\`.`,
		candidates,
	};
}
function indexCategories(ctx: OrgContext): Array<{ absPath: string; name: string; dir: string; prefix: string }> {
	return resolveCategories(ctx.config, ctx.projectRoot).map(category => ({
		absPath: category.absPath,
		name: category.name,
		dir: category.dirName,
		prefix: category.prefix,
	}));
}

async function indexedList(
	ctx: OrgContext,
	args: { includeBody?: boolean; category?: string | string[]; level?: number },
): Promise<OrgItem[]> {
	const categories = indexCategories(ctx);
	const categoryFilter =
		args.category === undefined ? undefined : Array.isArray(args.category) ? args.category : [args.category];
	const nativeFilter = {
		category: categoryFilter,
		level: args.level,
	};
	const result = await executeOrg({
		command: "orgIndexList",
		root: ctx.projectRoot,
		categories,
		todoKeywords: ctx.config.todoKeywords,
		includeBody: args.includeBody ?? false,
		filter: nativeFilter,
	});
	if (result.error) throw new Error(String(result.output));
	return ((result.output as { items?: OrgItem[] }).items ?? []) as OrgItem[];
}

async function cmdInit(ctx: OrgContext, args: { category?: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const targets = args.category
		? ([findCategory(categories, args.category)].filter(Boolean) as typeof categories)
		: categories;
	if (targets.length === 0) return { error: true, message: `Category not found: ${args.category}` };
	const results: Array<{
		category: string;
		absPath: string;
		created: boolean;
	}> = [];
	for (const cat of targets) {
		const existed = await fs
			.stat(cat.absPath)
			.then(() => true)
			.catch(() => false);
		await initCategoryDir(cat.absPath, cat.prefix, ctx.config.todoKeywords);
		results.push({
			category: cat.name,
			absPath: cat.absPath,
			created: !existed,
		});
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
		return {
			error: true,
			message: `Unknown state: "${state}". Valid: ${ctx.config.todoKeywords.join(", ")}`,
		};
	}
	await fs.mkdir(cat.absPath, { recursive: true });
	const session = cat.writeInitialPrompt ? (ctx.getSessionContext?.() as OrgSessionContext | undefined) : undefined;
	const { id, filePath, suboutlineRewrites } = await createCategoryMutex.withLock(cat.absPath, async () => {
		const id = await generateId(cat.absPath, cat.prefix, args.title);
		const fileName = args.file ? (args.file.endsWith(".org") ? args.file : `${args.file}.org`) : `${id}.org`;
		const filePath = path.join(cat.absPath, fileName);
		const rewriteResult = args.body === undefined ? undefined : rewriteSubOutlineIds(id, args.body);
		const rewrittenBody = rewriteResult?.body;
		const result = await executeOrg({
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
			root: ctx.projectRoot,
			categories: indexCategories(ctx),
			todoKeywords: ctx.config.todoKeywords,
		});
		if (result.error) throw new Error(String(result.output));
		return {
			id,
			filePath,
			suboutlineRewrites: rewriteResult ? Object.fromEntries(rewriteResult.rewrites) : undefined,
		};
	});
	const createdItem = args.body === undefined ? undefined : await fetchItem(ctx, id);
	const missingRequired = args.properties?.LAYER ? [] : ["LAYER"];
	const recommended = { DEPENDS: args.properties?.DEPENDS ? "set" : "unset" };
	logger.debug("org:create", { id, filePath, category: cat.name });
	return {
		success: true,
		id,
		file: filePath,
		category: cat.name,
		state,
		body: createdItem?.body,
		bodyLength: createdItem ? (createdItem.body ?? "").length : undefined,
		suboutlinePrefix: `${id}::`,
		missingRequired,
		recommended,
		suboutlineRewrites,
	};
}

async function cmdQuery(
	ctx: OrgContext,
	filter: OrgQueryFilter & {
		query?: string;
		ql?: string;
		sort?: string;
		limit?: number;
		offset?: number;
	},
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
	const allItems = await indexedList(ctx, {
		includeBody: filter.includeBody ?? false,
		category: targetCats.map(cat => cat.name),
		level: 0,
	});
	const filtered = applyFilter(allItems, { level: 0, ...merged });
	sortItems(filtered, filter.sort);
	return paginateResult(filtered, filtered.length, filter.limit, filter.offset);
}

async function cmdGet(ctx: OrgContext, args: { id: string }): Promise<unknown> {
	const item = await fetchItem(ctx, args.id);
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
	if (args.state && !ctx.config.todoKeywords.includes(args.state)) {
		return {
			error: true,
			message: `Unknown state: "${args.state}". Valid: ${ctx.config.todoKeywords.join(", ")}`,
		};
	}
	if (args.section !== undefined) {
		if ((args.body === undefined) === (args.append === undefined)) {
			return {
				error: true,
				message: "update with section requires exactly one of: body, append",
			};
		}
		if (args.state !== undefined || args.title !== undefined || args.note !== undefined) {
			return {
				error: true,
				message: "update with section cannot combine state, title, or note",
			};
		}
		const mode = args.body !== undefined ? "replace" : "append";
		const body = args.body ?? args.append ?? "";
		const rewrittenBody = rewriteSubOutlineIds(args.id, body).body;
		const trySectionUpdate = async (filePath: string): Promise<Record<string, unknown> | null> => {
			let result: Awaited<ReturnType<typeof executeOrg>>;
			try {
				result = await executeOrg({
					command: "editSection",
					file: filePath,
					id: args.id,
					section: args.section,
					body: rewrittenBody,
					mode,
					todoKeywords: ctx.config.todoKeywords,
					root: ctx.projectRoot,
					categories: indexCategories(ctx),
				});
			} catch {
				return null;
			}
			if (result.error) return null;
			logger.debug("org:update", {
				id: args.id,
				section: args.section,
				file: filePath,
			});
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
		if (!item)
			return {
				error: true,
				code: "NOT_FOUND",
				message: `Item not found: ${args.id}`,
			};
		return (
			(await trySectionUpdate(item.file)) ?? {
				error: true,
				code: "NOT_FOUND",
				message: `Item not found: ${args.id}`,
			}
		);
	}
	if (!args.state && args.body === undefined && args.append === undefined && !args.title && !args.note) {
		return {
			error: true,
			message: "update requires at least one of: state, body, append, title",
		};
	}
	const rewrittenBody = args.body === undefined ? undefined : rewriteSubOutlineIds(args.id, args.body).body;
	const rewrittenAppend = args.append === undefined ? undefined : rewriteSubOutlineIds(args.id, args.append).body;
	const tryUpdate = async (filePath: string): Promise<Record<string, unknown> | null> => {
		let result: Awaited<ReturnType<typeof executeOrg>>;
		try {
			result = await executeOrg({
				command: "updateItem",
				file: filePath,
				id: args.id,
				state: args.state,
				title: args.title,
				body: rewrittenBody,
				append: rewrittenAppend,
				note: args.note,
				todoKeywords: ctx.config.todoKeywords,
				root: ctx.projectRoot,
				categories: indexCategories(ctx),
			});
		} catch {
			return null;
		}
		if (result.error) return null;
		const output = result.output as { updated?: string[] };
		const response = await buildMutationResponse(
			args.id,
			output.updated ?? [],
			filePath,
			args.includeBody,
			ctx,
			args.body !== undefined ? "full" : args.append !== undefined ? "length" : undefined,
		);
		if (args.state === "DONE") {
			try {
				await emitCompletionEpisode(ctx, args.id, filePath);
			} catch (err) {
				logger.warn("org.completion-episode emit failed", { id: args.id, error: String(err) });
			}
		}
		return response;
	};
	if (args.file) {
		const direct = await tryUpdate(args.file);
		if (direct) return direct;
	}
	const item = await fetchItem(ctx, args.id);
	if (item && item.file !== args.file) {
		const response = await tryUpdate(item.file);
		if (response) return response;
	}
	return {
		error: true,
		code: "NOT_FOUND",
		message: `Item not found: ${args.id}`,
	};
}

/**
 * Auto-emit a memory episode when an org item transitions to DONE and carries
 * non-trivial completion content (a `* Completion` section or recent NOTE
 * lines). Idempotent via the `COMPLETION_HASH` property: re-saving the same
 * completion content is a no-op. PLAN-310 W7.
 */
async function emitCompletionEpisode(ctx: OrgContext, id: string, _filePath: string): Promise<void> {
	const item = await fetchItem(ctx, id);
	if (!item) return;
	const completionText = extractCompletionText(item.body ?? "");
	if (!completionText) return;
	const hash = createHash("sha256").update(`${item.title}\n${completionText}`).digest("hex").slice(0, 16);
	if (item.properties.COMPLETION_HASH === hash) return;

	const summary = `${item.title}\n\n${completionText}`;
	const result = await executeOrg({
		command: "remember",
		kind: "episode",
		summary,
		about: [item.id],
		repoRoot: ctx.projectRoot,
	});
	if (result.error) {
		throw new Error(`executeOrg(remember) failed: ${String(result.output)}`);
	}
	// Persist the hash on the source item so re-runs (re-saves of the same
	// completion text) skip cleanly. Best-effort: a failure here does not
	// invalidate the episode we just wrote.
	try {
		await executeOrg({
			command: "setProperty",
			file: item.file,
			id: item.id,
			property: "COMPLETION_HASH",
			value: hash,
			todoKeywords: ctx.config.todoKeywords,
			root: ctx.projectRoot,
			categories: indexCategories(ctx),
		});
	} catch (err) {
		logger.warn("org.completion-episode hash set failed", { id: item.id, error: String(err) });
	}
}

const COMPLETION_HEADING_RE = /^\*{1,6}\s+Completion\s*$([\s\S]*?)(?=^\*{1,6}\s|Z)/m;
const NOTE_LINE_RE = /^NOTE \[[^\]]+\]:\s*(.*)$/gm;

/**
 * Extract the body text of a `* Completion` heading (any nesting level) from
 * an org item body, or fall back to concatenated `NOTE [...]:` lines. Returns
 * `""` when neither is present, signalling “no completion content—skip”.
 */
export function extractCompletionText(body: string): string {
	const sectionMatch = COMPLETION_HEADING_RE.exec(body);
	if (sectionMatch?.[1]) {
		const inner = sectionMatch[1].trim();
		if (inner.length > 0) return inner;
	}
	const notes = [...body.matchAll(NOTE_LINE_RE)].map(m => m[1].trim()).filter(line => line.length > 0);
	if (notes.length === 0) return "";
	return notes.join("\n");
}

async function buildMutationResponse(
	id: string,
	updated: string[],
	file: string,
	includeBody: boolean | undefined,
	ctx: OrgContext,
	bodyResponse?: "full" | "length",
): Promise<Record<string, unknown>> {
	const response: Record<string, unknown> = {
		success: true,
		id,
		updated,
		file,
	};
	const item = includeBody || bodyResponse ? await fetchItem(ctx, id) : undefined;
	if (includeBody) response.item = item;
	if (bodyResponse) {
		if (bodyResponse === "full") response.body = item?.body;
		response.bodyLength = (item?.body ?? "").length;
	}
	return response;
}

async function cmdSet(
	ctx: OrgContext,
	args: {
		id: string;
		property: string;
		value: string;
		file?: string;
		includeBody?: boolean;
	},
): Promise<unknown> {
	const trySet = async (filePath: string): Promise<Record<string, unknown> | null> => {
		let result: Awaited<ReturnType<typeof executeOrg>>;
		try {
			result = await executeOrg({
				command: "setProperty",
				file: filePath,
				id: args.id,
				property: args.property,
				value: args.value,
				todoKeywords: ctx.config.todoKeywords,
				root: ctx.projectRoot,
				categories: indexCategories(ctx),
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
	const item = await fetchItem(ctx, args.id);
	if (item && item.file !== args.file) {
		const response = await trySet(item.file);
		if (response) return response;
	}
	return {
		error: true,
		code: "NOT_FOUND",
		message: `Item not found: ${args.id}`,
	};
}

async function cmdNote(
	ctx: OrgContext,
	args: { id: string; note: string; file?: string; includeBody?: boolean },
): Promise<unknown> {
	const tryNote = async (filePath: string): Promise<Record<string, unknown> | null> => {
		let result: Awaited<ReturnType<typeof executeOrg>>;
		try {
			result = await executeOrg({
				command: "appendNote",
				file: filePath,
				id: args.id,
				note: args.note,
				todoKeywords: ctx.config.todoKeywords,
				root: ctx.projectRoot,
				categories: indexCategories(ctx),
			});
		} catch {
			return null;
		}
		if (result.error) {
			if (result.output && typeof result.output === "object" && !Array.isArray(result.output)) {
				const output = result.output as Record<string, unknown>;
				if (output.code === "ITEM_NOT_FOUND") return null;
				return { error: true, ...output };
			}
			return { error: true, message: String(result.output) };
		}
		return await buildMutationResponse(args.id, ["note"], filePath, args.includeBody, ctx);
	};
	if (args.file) {
		const direct = await tryNote(args.file);
		if (direct) return direct;
	}
	const item = await fetchItem(ctx, args.id);
	if (item && item.file !== args.file) {
		const response = await tryNote(item.file);
		if (response) return response;
	}
	return {
		error: true,
		code: "NOT_FOUND",
		message: `Item not found: ${args.id}`,
	};
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
	if (!item)
		return {
			error: true,
			code: "NOT_FOUND",
			message: `Item not found: ${args.id}`,
		};
	if (item.state === "DOING" || item.state === "REVIEW") {
		return {
			error: true,
			message: `Cannot delete active item ${args.id} while it is ${item.state}`,
		};
	}

	await fs.unlink(item.file);
	return { success: true, id: item.id, file: item.file, deleted: true };
}
async function cmdDashboard(ctx: OrgContext): Promise<unknown> {
	const result = await executeOrg({
		command: "orgIndexDashboard",
		root: ctx.projectRoot,
		categories: indexCategories(ctx),
		todoKeywords: ctx.config.todoKeywords,
	});
	if (result.error) throw new Error(String(result.output));
	return result.output;
}

async function cmdSuboutlineAdd(
	ctx: OrgContext,
	args: {
		parentId: string;
		slug: string;
		title: string;
		body?: string;
		depends?: string[];
		layer?: string;
		replace?: boolean;
	},
): Promise<unknown> {
	if (!SUBOUTLINE_SLUG_RE.test(args.slug)) {
		return { error: true, code: "INVALID_SUBOUTLINE_SLUG", message: `Invalid slug: ${args.slug}` };
	}
	if (args.body && TOP_LEVEL_HEADING_RE.test(args.body)) {
		return {
			error: true,
			code: "INVALID_SUBOUTLINE_BODY",
			message: "body must not start a top-level heading; use N-star headings only",
		};
	}
	if (args.replace) {
		return { error: true, code: "UNSUPPORTED", message: "replace=true is not supported for suboutline-add" };
	}

	const parentItem = await fetchItem(ctx, args.parentId);
	if (!parentItem) {
		return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.parentId}` };
	}
	const parentBody = parentItem.body ?? "";
	const existingIds = collectSameParentSuboutlineIds(parentItem.id, parentBody);
	const suboutlineId = `${parentItem.id}::${args.slug}`;
	if (existingIds.has(suboutlineId)) {
		return { error: true, code: "ALREADY_EXISTS", message: `Suboutline already exists: ${suboutlineId}` };
	}
	for (const depId of args.depends ?? []) {
		if (!existingIds.has(depId)) {
			return {
				error: true,
				code: "INVALID_DEPENDS",
				message: `DEPENDS must reference an existing same-parent suboutline: ${depId}`,
			};
		}
	}
	const block = buildSuboutlineBlock(args);
	const append = `${parentBody.trim().length > 0 ? "\n\n" : ""}${block}`;
	const result = await createCategoryMutex.withLock(
		parentItem.file,
		async () =>
			await executeOrg({
				command: "updateItem",
				file: parentItem.file,
				id: parentItem.id,
				append,
				todoKeywords: ctx.config.todoKeywords,
				root: ctx.projectRoot,
				categories: indexCategories(ctx),
			}),
	);
	if (result.error) {
		return { error: true, message: String(result.output) };
	}
	return { success: true, suboutlineId, file: parentItem.file, updated: ["append"] };
}

async function cmdValidate(ctx: OrgContext, args: { category?: string; file?: string }): Promise<unknown> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const targets = args.category ? categories.filter(c => c.name === args.category) : categories;
	const issues: ValidationIssue[] = [];
	for (const cat of targets) {
		const items = await indexedList(ctx, { category: cat.name, includeBody: false });
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
		return {
			error: true,
			message: "validate-plan is not available in this org tool context",
		};
	}

	return ctx.validatePlan(args.id);
}
async function collectItems(ctx: OrgContext, args: { file?: string; category?: string }): Promise<OrgItem[]> {
	const categories = resolveCategories(ctx.config, ctx.projectRoot);
	const targets = args.category
		? categories.filter(cat => cat.name === args.category || cat.prefix === args.category).map(cat => cat.name)
		: undefined;
	const items = await indexedList(ctx, { category: targets, includeBody: false });
	return args.file ? items.filter(item => item.file === args.file) : items;
}

async function collectPlanWaveItems(
	ctx: OrgContext,
	planItemId: string,
): Promise<{ planItem?: OrgItem; items: OrgItem[]; warnings: string[]; notFound?: boolean }> {
	const planItem = await fetchItem(ctx, planItemId);
	if (!planItem) return { items: [], warnings: [], notFound: true };
	const linkedIds = extractIdLinks(planItem.body ?? "");
	if (linkedIds.length === 0) {
		return { planItem, items: [], warnings: ["no linked child items; manifest not written"] };
	}

	const items: OrgItem[] = [];
	const seenItems = new Set<string>();
	const warnings: string[] = [];
	const addItem = (item: OrgItem): void => {
		const key = `${item.file}:${item.line}:${item.id}`;
		if (seenItems.has(key)) return;
		seenItems.add(key);
		items.push(item);
	};
	const indexedItems = await indexedList(ctx, { includeBody: false });
	for (const linkedId of linkedIds) {
		const subOutline = parseSubOutlineId(linkedId);
		if (subOutline) {
			const found = indexedItems.filter(item => item.id === linkedId);
			if (found.length === 0) {
				const parentExists = indexedItems.some(item => item.id === subOutline.parentId);
				warnings.push(
					`linked ${parentExists ? "sub-outline" : "child"} not found: ${parentExists ? linkedId : subOutline.parentId}`,
				);
				continue;
			}
			for (const item of found) addItem(item);
			continue;
		}

		const childItems = indexedItems.filter(item => item.id === linkedId);
		if (childItems.length === 0) {
			warnings.push(`linked child not found: ${linkedId}`);
			continue;
		}
		for (const item of indexedItems) {
			if (item.level < 2) continue;
			if (!item.id.startsWith(`${linkedId}::`)) continue;
			addItem(item);
		}
	}

	return { planItem, items: items.sort(compareOrgItemLocation), warnings };
}

function manifestSectionBody(manifest: string): string {
	const [heading, ...rest] = manifest.split("\n");
	return heading === "* Execution Manifest" ? rest.join("\n") : manifest;
}

async function writeManifestSection(
	ctx: OrgContext,
	planItem: OrgItem,
	planItemId: string,
	manifest: string,
): Promise<{ success: true } | { error: true; message: string }> {
	const body = manifestSectionBody(manifest);
	try {
		const replaceResult = await executeOrg({
			command: "editSection",
			file: planItem.file,
			id: planItemId,
			section: "Execution Manifest",
			body,
			mode: "replace",
			todoKeywords: ctx.config.todoKeywords,
			root: ctx.projectRoot,
			categories: indexCategories(ctx),
		});
		if (!replaceResult.error) return { success: true };
		const replaceOutput = replaceResult.output as { code?: string; message?: string } | string;
		if (typeof replaceOutput === "object" && replaceOutput?.code !== "SECTION_NOT_FOUND") {
			return { error: true, message: replaceOutput.message ?? String(replaceResult.output) };
		}
	} catch (error) {
		return { error: true, message: error instanceof Error ? error.message : String(error) };
	}

	try {
		const appendResult = await executeOrg({
			command: "updateItem",
			file: planItem.file,
			id: planItemId,
			append: `\n\n${manifest}`,
			todoKeywords: ctx.config.todoKeywords,
			root: ctx.projectRoot,
			categories: indexCategories(ctx),
		});
		if (!appendResult.error) return { success: true };
		const appendOutput = appendResult.output as { message?: string } | string;
		return {
			error: true,
			message:
				typeof appendOutput === "object"
					? (appendOutput.message ?? String(appendResult.output))
					: String(appendOutput),
		};
	} catch (error) {
		return { error: true, message: error instanceof Error ? error.message : String(error) };
	}
}

function formatDagSection(title: string, dag: OrgDag): string[] {
	const lines = [`** ${title}`, "*** Nodes"];
	if (dag.nodes.length === 0) {
		lines.push("- None.");
	} else {
		for (const node of dag.nodes) lines.push(`- \`${node.id}\` ${node.title} [${node.state}]`);
	}
	lines.push("*** Edges");
	if (dag.edges.length === 0) {
		lines.push("- None.");
	} else {
		for (const edge of dag.edges) lines.push(`- \`${edge.from}\` depends on \`${edge.to}\``);
	}
	return lines;
}

function formatExecutionManifest(waves: ComputedWave[], dags?: { fileDag: OrgDag; subfeatureDag: OrgDag }): string {
	if (waves.length === 0 && !dags) return "* Execution Manifest\n(No sub-outlines with dependencies found.)\n";
	const lines: string[] = ["* Execution Manifest"];
	if (waves.length === 0) {
		lines.push("(No sub-outlines with dependencies found.)");
	} else {
		for (const wave of waves) {
			lines.push(`** wave-${wave.number + 1} :wave:`);
			for (const item of wave.items) lines.push(`- [[id:${item.custom_id}]] ${item.title}`);
		}
	}
	if (dags) {
		lines.push(...formatDagSection("File-level DAG", dags.fileDag));
		lines.push(...formatDagSection("Subfeature-level DAG", dags.subfeatureDag));
	}
	lines.push("");
	return lines.join("\n");
}

function requireComputedWaveResult(
	output: unknown,
): ComputedWaveResult | { error: true; code: string; message: string } {
	const candidate = output as Partial<ComputedWaveResult>;
	if (!candidate.file_dag || !candidate.subfeature_dag) {
		return {
			error: true,
			code: "MISSING_DAG_OUTPUT",
			message: "Native computeWaves output missing DAG fields; rebuild the native addon.",
		};
	}
	return {
		waves: candidate.waves ?? [],
		warnings: candidate.warnings ?? [],
		total_sub_outlines: candidate.total_sub_outlines ?? 0,
		subfeature_dag: candidate.subfeature_dag,
		file_dag: candidate.file_dag,
	};
}

async function cmdWave(
	ctx: OrgContext,
	args: { file?: string; category?: string; manifest?: boolean; planItemId?: string },
): Promise<unknown> {
	if (args.planItemId) {
		const collected = await collectPlanWaveItems(ctx, args.planItemId);
		if (collected.notFound || !collected.planItem) {
			return { error: true, code: "NOT_FOUND", message: `Item not found: ${args.planItemId}` };
		}
		if (!args.manifest) {
			return { error: true, code: "MANIFEST_REQUIRED", message: "planItemId requires manifest=true" };
		}
		if (collected.items.length === 0) {
			return {
				manifest: "",
				waves: [],
				warnings: collected.warnings,
				total_sub_outlines: 0,
				wrote_to_plan: false,
				plan_file: collected.planItem.file,
				plan_item_id: args.planItemId,
			};
		}
		const raw = await executeOrg({ command: "computeWaves", items: collected.items, doneStates: ["DONE"] });
		if (raw.error) return raw.output;
		const output = requireComputedWaveResult(raw.output);
		if ("error" in output) return output;
		const manifest = formatExecutionManifest(output.waves, {
			fileDag: output.file_dag,
			subfeatureDag: output.subfeature_dag,
		});
		const writeResult = await writeManifestSection(ctx, collected.planItem, args.planItemId, manifest);
		if ("error" in writeResult) return writeResult;
		return {
			manifest,
			waves: output.waves ?? [],
			warnings: [...collected.warnings, ...output.warnings],
			total_sub_outlines: output.total_sub_outlines,
			subfeature_dag: output.subfeature_dag,
			file_dag: output.file_dag,
			wrote_to_plan: true,
			plan_file: collected.planItem.file,
			plan_item_id: args.planItemId,
		};
	}

	const items = await collectItems(ctx, args);
	const raw = await executeOrg({
		command: args.manifest ? "computeWaves" : "nextWave",
		items,
		doneStates: ["DONE"],
	});
	if (raw.error) return raw.output;
	if (args.manifest) {
		const output = requireComputedWaveResult(raw.output);
		if ("error" in output) return output;
		return {
			manifest: formatExecutionManifest(output.waves, {
				fileDag: output.file_dag,
				subfeatureDag: output.subfeature_dag,
			}),
			waves: output.waves,
			warnings: output.warnings,
			total_sub_outlines: output.total_sub_outlines,
			subfeature_dag: output.subfeature_dag,
			file_dag: output.file_dag,
		};
	}
	return raw.output;
}

async function cmdGraph(ctx: OrgContext, args: { file?: string; category?: string }): Promise<unknown> {
	const items = await collectItems(ctx, args);
	const raw = await executeOrg({ command: "graph", items });
	return raw.output;
}

async function cmdArchive(ctx: OrgContext, args: { category?: string }): Promise<unknown> {
	const result = await executeOrg({
		command: "orgIndexArchive",
		root: ctx.projectRoot,
		categories: indexCategories(ctx),
		todoKeywords: ctx.config.todoKeywords,
		category: args.category,
	});
	if (result.error) throw new Error(String(result.output));
	return result.output;
}

/**
 * Dispatch a resolved org command to its handler. Extracted from the tool's
 * `execute` so the implicit-id resolution pre-pass (see {@link resolveImplicitId})
 * can run uniformly before this switch and attach warnings after it.
 */
async function dispatchOrgCommand(ctx: OrgContext, command: string, args: Record<string, unknown>): Promise<unknown> {
	switch (command) {
		case "init":
			return cmdInit(ctx, {
				category: args.category as string | undefined,
			});
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
		case "validate-plan":
			return cmdValidatePlan(ctx, { id: args.id as string });
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
				planItemId: args.planItemId as string | undefined,
			});
		case "graph":
			return cmdGraph(ctx, {
				file: args.file as string | undefined,
				category: args.category as string | undefined,
			});
		case "archive":
			return cmdArchive(ctx, {
				category: args.category as string | undefined,
			});
		case "suboutline-add":
			return cmdSuboutlineAdd(ctx, {
				parentId: args.parentId as string,
				slug: args.slug as string,
				title: args.title as string,
				body: normalizeOrgBody(args.body as string | undefined),
				depends: Array.isArray(args.depends) ? (args.depends as string[]) : undefined,
				layer: args.layer as string | undefined,
				replace: args.replace as boolean | undefined,
			});
		default:
			return { error: true, message: `Unknown command: ${command}` };
	}
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
		description: `Org-mode project management. Subcommands:\n  init        Initialize org directories and category subdirs\n  create      Create a new task item (ID auto-generated)\n  query       List/filter items (state, category, priority, layer, or keyword query)\n  get         Get single item by ID with full body\n  update      Change state, body, title, or append text (any combo in one call)\n  note        Append a dated NOTE entry to an item (no state change)\n  set         Set a single PROPERTIES drawer value\n  validate    Validate items\n  delete       Delete an item file\n  validate-plan Validate a plan via injected callback\n  dashboard   Project metrics and in-progress/blocked summary\n  wave        Next wave of ready items by priority\n  graph       Dependency graph\n  archive     Archive DONE items\n  suboutline-add Append a structured implementation sub-heading to an existing item with auto-prefixed CUSTOM_ID.\n\nID args (id/parentId/planItemId) accept a partial CUSTOM_ID: an unambiguous prefix resolves to the full ID (with a warning); an ambiguous prefix returns AMBIGUOUS_ID listing the candidates. Pass the full ID or use \`query\` to avoid the lookup.\n`,
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
						"delete",
						"validate-plan",
						"dashboard",
						"wave",
						"graph",
						"archive",
						"suboutline-add",
					],
				},
			},
			required: ["command"],
		},
		async execute(args: Record<string, unknown>): Promise<unknown> {
			const command = args.command as string;
			// FEAT: implicit prefix resolution. Each id-bearing command names the arg
			// key holding a CUSTOM_ID; resolve it against the index before dispatch so
			// a partial id (e.g. "FEAT-815" for file "FEAT-815-foo") still hits,
			// ambiguity short-circuits, and an exact id is left untouched.
			const idArg = ID_ARG_BY_COMMAND[command];
			let idWarning: string | undefined;
			if (idArg !== undefined) {
				const rawId = args[idArg];
				if (typeof rawId === "string" && rawId.length > 0) {
					const resolution = await resolveImplicitId(ctx, rawId);
					if (!resolution.ok) return resolution;
					args[idArg] = resolution.id;
					idWarning = resolution.warning;
				}
			}
			const result = await dispatchOrgCommand(ctx, command, args);
			if (idWarning !== undefined && typeof result === "object" && result !== null && !("error" in result)) {
				(result as Record<string, unknown>).idWarning = idWarning;
			}
			return result;
		},
		async dispose() {
			// No-op: native engine has no persistent state to clean up.
		},
	};
}
