/**
 * Memory tool — unified surface for recall, save, link, and graph traversal.
 *
 * Wraps the native executeOrg memory commands (recall · remember · subgraph ·
 * link · timeline) under a single action-discriminated tool. Replaces the five
 * org subcommands that were deleted in PLAN-310 W6.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
} from "@oh-my-pi/pi-agent-core";
import { executeOrg } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { Theme } from "../modes/theme/theme";
import memoryDescription from "../prompts/tools/memory.md" with { type: "text" };
import { renderStatusLine } from "../tui/status-line";
import type { ToolSession } from ".";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";

// Actions that *read* from the recall lane and therefore benefit from
// surfacing daemon warm-load progress to the agent. Writes (note / save /
// link) don't touch the lane on the read path, so they don't need it.
const READ_ACTIONS = new Set<string>(["search", "about", "neighbors", "since"]);

/** Shape of the `org_lane` payload returned by `executeOrg({command:'recall_stats'})`. */
export interface MemoryProgressSnapshot {
	status: "cold" | "warming" | "warm" | "error" | "unavailable";
	progress?: {
		phase: "cold" | "scan" | "embed" | "index" | "done";
		done: number;
		total: number;
		started_ms: number;
	};
	error?: string;
}

/**
 * Read the daemon's current warm-load state for `repoRoot`. Cheap: the
 * daemon serves this from atomics without touching the warm-load worker
 * thread (PLAN-316). FEAT-780: now async because `executeOrg` is async;
 * the underlying daemon call is still sub-ms.
 *
 * Returns `{ status: "unavailable" }` when the daemon is unreachable so
 * callers never latch on a stale spinner and never trigger the slow
 * `init` path during startup probes.
 */
export async function peekMemoryProgress(repoRoot: string): Promise<MemoryProgressSnapshot> {
	try {
		const result = await executeOrg({ command: "recall_stats", repoRoot });
		if (result.error) {
			// Old daemon binaries that don't recognise the command, or any
			// other RPC error. Treat as `unavailable` so callers skip rather
			// than triggering the slow `init` path.
			return { status: "unavailable" };
		}
		return (result.output as MemoryProgressSnapshot) ?? { status: "unavailable" };
	} catch {
		return { status: "unavailable" };
	}
}

/**
 * Best-effort eager warm of the daemon's recall lane for `repoRoot`.
 *
 * Skips silently when the daemon's capabilities haven't been probed yet
 * (would otherwise trigger the 5–30 s bge-m3 model load and block
 * session start). Effective when the daemon is already initialised, e.g.
 * for the second `spell` invocation in the same daemon lifetime, or
 * after the agent has issued at least one memory query.
 *
 * The non-blocking warm-load on the daemon side (PLAN-316) means the
 * subsequent `open` returns in milliseconds; only the model load is the
 * irreducible cost, and it only happens on an explicit user query.
 */
export function warmMemoryLane(repoRoot: string): void {
	// FEAT-780: fire-and-forget. The Promise is intentionally not awaited
	// so callers can keep their sync surface; warm is best-effort and any
	// failure is logged-and-swallowed.
	executeOrg({ command: "recall_warm", repoRoot }).catch((err: unknown) => {
		logger.debug("warmMemoryLane: ignored error", {
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

async function emitProgressPreambleIfWarming(
	repoRoot: string,
	onUpdate: AgentToolUpdateCallback,
): Promise<void> {
	// Only emit when the daemon explicitly reports `warming`. `unavailable`
	// / `unknown` / `warm` don't need a spinner preamble.
	const snapshot = await peekMemoryProgress(repoRoot);
	if (snapshot.status !== "warming") return;
	const { done = 0, total = 0, phase = "scan" } = snapshot.progress ?? {};
	const suffix = total > 0 ? ` ${done}/${total} (${phase})` : ` (${phase})`;
	onUpdate({ content: [{ type: "text", text: `📚 indexing org memory…${suffix}` }] });
}

/**
 * Canonical node kinds (mirrors `RecallKind` in `pi-knowledge-core::recall`).
 * Used by `scope`, `kind` (save), and `scope_personal_only`'s implicit filter.
 */
export const MEMORY_NODE_KINDS = ["episode", "concept", "playbook", "decision", "entity", "actor", "workflow"] as const;

/**
 * Canonical edge kinds (mirrors the closed variants of `EdgeKind` in
 * `pi-knowledge-core::graph`; `Other(String)` forward-compat lives in Rust).
 * Used by `kind` (link), `kinds[]`, and `relations[].kind`.
 */
export const MEMORY_EDGE_KINDS = [
	"DEFINES",
	"IMPORTS",
	"CALLS",
	"REFERENCES",
	"INHERITS",
	"RENDERS",
	"STYLES",
	"REQUIRES",
	"REFERS",
	"ALIASES",
	"IMPLEMENTS",
	"DISPATCHES",
	"TESTS",
	"USES_KEYWORD",
	"TYPE_IMPORTS",
	"TYPE_PARAMETER_OF",
	"INVOLVED",
	"ABOUT",
	"PRODUCED",
	"DISTILLED_FROM",
	"MENTIONS",
	"SUPERSEDES",
	"DERIVED_FROM",
	"BLOCKS",
	"ACTION",
	"CONTAINS",
] as const;

const NodeKindLit = Type.Union(MEMORY_NODE_KINDS.map(k => Type.Literal(k)));
const EdgeKindLit = Type.Union(MEMORY_EDGE_KINDS.map(k => Type.Literal(k)));

export const memorySchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("search"),
			Type.Literal("about"),
			Type.Literal("neighbors"),
			Type.Literal("note"),
			Type.Literal("save"),
			Type.Literal("link"),
			Type.Literal("since"),
		],
		{ description: "search | about | neighbors | note | save | link | since" },
	),

	// Unified text field: `search` query · `note` summary · `save` body context.
	text: Type.Optional(Type.String({ description: "Search query (search) · episode summary (note)" })),
	// Unified kind field: `save` node kind · `link` edge kind · `neighbors` n/a.
	kind: Type.Optional(
		Type.Union([NodeKindLit, EdgeKindLit], {
			description:
				"save: episode|concept|playbook|decision · link: INVOLVED|ABOUT|PRODUCED|DISTILLED_FROM|SUPERSEDES|…",
		}),
	),

	// search / about / neighbors / since
	id: Type.Optional(Type.String({ description: "Item id (about) or focus fallback (neighbors)" })),
	scope: Type.Optional(
		Type.Array(NodeKindLit, {
			description: "Kind filter: episode | concept | playbook | decision | entity | actor | workflow",
		}),
	),
	focus: Type.Optional(Type.String({ description: "Graph focus node id (search, neighbors)" })),
	hops: Type.Optional(Type.Number({ description: "Graph hop depth (default 1)" })),
	kinds: Type.Optional(Type.Array(EdgeKindLit, { description: "Edge kind filter (neighbors)" })),
	limit: Type.Optional(Type.Number({ description: "Max hits (search)" })),
	profile: Type.Optional(Type.String({ description: "Recall profile name (search)" })),
	include_personal: Type.Optional(
		Type.Boolean({
			description: "Union with personal-store memories (search; default false)",
		}),
	),
	scope_personal_only: Type.Optional(
		Type.Boolean({
			description: "Restrict search to personal store only (search; default false)",
		}),
	),
	ts: Type.Optional(
		Type.Union([Type.String(), Type.Number()], {
			description: "ISO-8601 string or epoch-ms number (since)",
		}),
	),

	// note / save edge-list shorthands (note inherits these from the unified set)
	about: Type.Optional(Type.Array(Type.String(), { description: "ABOUT edges (note, save)" })),
	involved: Type.Optional(Type.Array(Type.String(), { description: "INVOLVED edges (note, save)" })),

	// save
	title: Type.Optional(Type.String({ description: "Title (save)" })),
	body: Type.Optional(Type.String({ description: "Body (save)" })),
	distilled_from: Type.Optional(Type.Array(Type.String(), { description: "DISTILLED_FROM edges (save)" })),
	relations: Type.Optional(
		Type.Array(Type.Object({ kind: EdgeKindLit, target: Type.String() }), {
			description: "Additional typed edges (save)",
		}),
	),

	// link
	from: Type.Optional(Type.String({ description: "Source id (link)" })),
	to: Type.Optional(Type.String({ description: "Target id (link)" })),

	_i: Type.Optional(Type.String({ description: "Intent: ≤6 words, present participle" })),
});

export type MemoryParams = Static<typeof memorySchema>;
type MemoryAction = MemoryParams["action"];
type MemoryDetails = { error?: boolean };

/** Memory sub-directories scanned by `since`. */
const SINCE_SCAN_DIRS = ["concepts", "episodes", "playbooks", "decisions"] as const;

/**
 * Granularity note for `since` results. Filesystem mtime distinguishes
 * touched-vs-untouched but cannot separate add-from-modify or detect deletes
 * without a snapshot. W7 returns everything as `modified` and documents the
 * deferral; finer-grained diffing lands when the recall engine persists a
 * watermark/manifest.
 */
const SINCE_GRANULARITY_NOTE = "granularity: file-mtime only; added/deleted deferred — see PLAN-310 W7";

export class MemoryTool implements AgentTool<typeof memorySchema, MemoryDetails, Theme> {
	readonly name = "memory";
	readonly label = "Memory";
	readonly description = memoryDescription;
	readonly parameters = memorySchema;
	// Lenient validation matches the tool-suite convention (find/get/edit/…):
	// unknown fields pass through. Closed enum on `kind`/`scope`/`kinds`/
	// `relations[].kind` (F5) still rejects bad *values*, so the strictness
	// ratchet only relaxes for forward-compat *fields*.
	readonly lenientArgValidation = true;

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	renderCall(args: MemoryParams, _options: RenderResultOptions, theme: Theme): Component {
		const preview = buildMemoryCallPreview(args);
		return new Text(
			renderStatusLine(
				{ icon: "pending", title: "Memory", description: preview.description, meta: preview.meta },
				theme,
			),
			0,
			0,
		);
	}

	async execute(
		_toolCallId: string,
		params: MemoryParams,
		_signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const repoRoot = this.#session.cwd ?? getProjectDir();
		try {
			// Surface daemon warm-load progress before a read-side call so the
			// user sees "indexing…" instead of a silent hang on the first call.
			// Cheap: `recall_stats` reads atomics on the daemon side (PLAN-316).
			if (READ_ACTIONS.has(params.action) && onUpdate) {
				await emitProgressPreambleIfWarming(repoRoot, onUpdate);
			}
			const output = await dispatchMemoryAction(params, repoRoot);
			const text = formatMemoryResult(output, params.action);
			return { content: [{ type: "text", text }] };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("memory tool error", { error: msg, action: params.action });
			return {
				content: [{ type: "text", text: JSON.stringify({ error: true, message: msg }) }],
				details: { error: true },
			};
		}
	}

	renderResult(result: AgentToolResult): Component {
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { type: string; text: string }).text)
			.join("");
		return new Text(replaceTabs(text).slice(0, 500), 0, 0);
	}
}

/**
 * Compact, content-free digest of `params` for telemetry. Booleans + lengths
 * only — free text (`text`, `body`) never reaches the log stream.
 */
function digestMemoryArgs(params: MemoryParams): Record<string, unknown> {
	return {
		action: params.action,
		hasText: typeof params.text === "string" && params.text.length > 0,
		textLen: typeof params.text === "string" ? params.text.length : 0,
		hasBody: typeof params.body === "string" && params.body.length > 0,
		bodyLen: typeof params.body === "string" ? params.body.length : 0,
		kind: params.kind,
		scope: params.scope,
		hasFocus: typeof params.focus === "string" && params.focus.length > 0,
		hasId: typeof params.id === "string" && params.id.length > 0,
		hops: params.hops,
		limit: params.limit,
		includePersonal: params.include_personal === true,
		scopePersonalOnly: params.scope_personal_only === true,
		relationsCount: params.relations?.length ?? 0,
	};
}

/**
 * Dispatch a memory `action` to the right executeOrg command. Pure, exported
 * for unit tests.
 */
export async function dispatchMemoryAction(params: MemoryParams, repoRoot: string): Promise<unknown> {
	logger.debug("memory.dispatch", digestMemoryArgs(params));
	switch (params.action) {
		case "search": {
			const result = await executeOrg({
				command: "recall",
				text: params.text,
				scope: params.scope,
				focus: params.focus,
				graphHops: params.hops,
				limit: params.limit,
				includePersonal: params.include_personal,
				profile: params.profile,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "about": {
			const focusId = params.id ?? params.focus;
			if (!focusId) throw new Error("memory.about requires `id`");
			// subgraph(hops=1) is the cheapest single-node fetch the native
			// surface offers; we then narrow it to {node, neighbors[], lineage[]}.
			const result = await executeOrg({
				command: "subgraph",
				root: focusId,
				hops: 1,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return buildAboutResult(focusId, result.output);
		}
		case "neighbors": {
			const focusId = params.focus ?? params.id;
			if (!focusId) throw new Error("memory.neighbors requires `focus` or `id`");
			const result = await executeOrg({
				command: "subgraph",
				root: focusId,
				hops: params.hops ?? 1,
				kinds: params.kinds,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "note": {
			if (!params.text) throw new Error("memory.note requires `text`");
			const result = await executeOrg({
				command: "remember",
				kind: "episode",
				summary: params.text,
				about: params.about,
				involves: params.involved,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "save": {
			if (!params.kind) throw new Error("memory.save requires `kind`");
			if (!params.title) throw new Error("memory.save requires `title`");
			const summary = params.body ? `${params.title}\n\n${params.body}` : params.title;
			const relationAbout = params.relations?.filter(r => r.kind === "ABOUT").map(r => r.target);
			const relationInvolved = params.relations?.filter(r => r.kind === "INVOLVED").map(r => r.target);
			const relationProduced = params.relations?.filter(r => r.kind === "PRODUCED").map(r => r.target);
			const relationSupersedes = params.relations?.filter(r => r.kind === "SUPERSEDES").map(r => r.target);
			// Merge top-level `about`/`involved` shorthand with `relations[]` entries.
			const aboutEdges = mergeEdgeLists(params.about, relationAbout);
			const involvesEdges = mergeEdgeLists(params.involved, relationInvolved);
			const result = await executeOrg({
				command: "remember",
				kind: params.kind,
				summary,
				distilledFrom: params.distilled_from,
				about: aboutEdges,
				involves: involvesEdges,
				produced: relationProduced && relationProduced.length > 0 ? relationProduced : undefined,
				supersedes: relationSupersedes && relationSupersedes.length > 0 ? relationSupersedes : undefined,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "link": {
			if (!params.from || !params.to || !params.kind) {
				throw new Error("memory.link requires `from`, `to`, and `kind`");
			}
			const result = await executeOrg({
				command: "link",
				from: params.from,
				to: params.to,
				kind: params.kind,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "since": {
			if (params.ts === undefined) throw new Error("memory.since requires `ts`");
			const tsIso = normalizeTsToIso(params.ts);
			return await diffMemorySince(repoRoot, tsIso);
		}
		default: {
			const exhaustive: never = params.action;
			throw new Error(`Unknown memory action: ${String(exhaustive)}`);
		}
	}
}

function mergeEdgeLists(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
	const merged = [...(a ?? []), ...(b ?? [])];
	if (merged.length === 0) return undefined;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of merged) {
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * Accept ISO-8601 string OR epoch-ms number; return canonical ISO string.
 * `Date.parse` accepts most ISO variants; pure digits route through `new Date(n)`.
 */
function normalizeTsToIso(ts: string | number): string {
	if (typeof ts === "number") {
		if (!Number.isFinite(ts)) throw new Error(`memory.since: invalid timestamp: ${ts}`);
		return new Date(ts).toISOString();
	}
	return ts;
}

/**
 * Reshape a `subgraph(hops=1)` result into the agent-facing `about` payload:
 *   { node:{id,kind,title}, neighbors:[{id,kind,via}], lineage:[id, …] }
 *
 * `via` is the edge kind that connects the neighbour to the focus, with
 * direction encoded by edge orientation (out = focus→other, in = other→focus).
 * `lineage` is the focus's 1-hop closure over DISTILLED_FROM / SUPERSEDES —
 * the "where did this come from" chain T10.9 asserts.
 */
function buildAboutResult(
	focusId: string,
	output: unknown,
): {
	node: { id: string; kind?: string; title?: string };
	neighbors: Array<{ id: string; kind: string; via: "in" | "out" }>;
	lineage: string[];
} {
	const { nodes, edges } = output as {
		nodes?: Array<Record<string, unknown>>;
		edges?: Array<Record<string, unknown>>;
	};
	const nodeArr = Array.isArray(nodes) ? nodes : [];
	const edgeArr = Array.isArray(edges) ? edges : [];
	const seed = nodeArr.find(n => n.id === focusId);
	const node = {
		id: focusId,
		kind: typeof seed?.kind === "string" ? (seed.kind as string) : undefined,
		title: typeof seed?.title === "string" ? (seed.title as string) : undefined,
	};
	const neighborSeen = new Set<string>();
	const neighbors: Array<{ id: string; kind: string; via: "in" | "out" }> = [];
	const lineage: string[] = [];
	const lineageSeen = new Set<string>();
	for (const edge of edgeArr) {
		const from = String(edge.from ?? "");
		const to = String(edge.to ?? "");
		const kind = String(edge.kind ?? "");
		if (from !== focusId && to !== focusId) continue;
		const via: "in" | "out" = from === focusId ? "out" : "in";
		const otherId = via === "out" ? to : from;
		const key = `${otherId}|${kind}|${via}`;
		if (!neighborSeen.has(key)) {
			neighborSeen.add(key);
			neighbors.push({ id: otherId, kind, via });
		}
		if ((kind === "DISTILLED_FROM" || kind === "SUPERSEDES") && !lineageSeen.has(otherId)) {
			lineageSeen.add(otherId);
			lineage.push(otherId);
		}
	}
	return { node, neighbors, lineage };
}

/**
 * Real `memory.since` implementation. Walks per-kind memory directories under
 * `<repoRoot>/.spell/memory/<kind>/`, stats each `.org` file, and returns the
 * ones with mtime strictly after `tsIso`.
 *
 * Returned as `modified`; add/delete granularity is deferred (see
 * SINCE_GRANULARITY_NOTE). Future-timestamps and missing dirs yield an empty
 * result, never an error.
 */
export async function diffMemorySince(
	repoRoot: string,
	tsIso: string,
): Promise<{
	added: Array<{ id: string; file: string; mtime: string }>;
	modified: Array<{ id: string; file: string; mtime: string }>;
	deleted: unknown[];
	ts: string;
	note: string;
}> {
	const tsMs = Date.parse(tsIso);
	if (!Number.isFinite(tsMs)) {
		throw new Error(`memory.since: invalid timestamp: ${tsIso}`);
	}
	const memoryRoot = path.join(repoRoot, ".spell", "memory");
	const added: Array<{ id: string; file: string; mtime: string }> = [];
	const modified: Array<{ id: string; file: string; mtime: string }> = [];
	for (const sub of SINCE_SCAN_DIRS) {
		const dir = path.join(memoryRoot, sub);
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		for (const name of entries) {
			if (!name.endsWith(".org")) continue;
			const file = path.join(dir, name);
			let stat: { mtimeMs: number; birthtimeMs: number };
			try {
				stat = await fs.stat(file);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw err;
			}
			if (stat.mtimeMs <= tsMs) continue;
			const id = await extractFirstCustomId(file, sub, name);
			const entry = { id, file, mtime: new Date(stat.mtimeMs).toISOString() };
			// PLAN-315 W7 (T10.6 fix): distinguish newly-created from
			// modified-after-creation files via birthtime. A file whose
			// birthtime postdates the cutoff is `added`; otherwise it
			// existed before and was mutated → `modified`.
			//
			// birthtimeMs is 0 on filesystems that don't support birthtime;
			// fall back to mtime-based classification (treat as modified) so
			// behaviour stays close to pre-fix on unsupported FS.
			const createdAfter = stat.birthtimeMs > 0 && stat.birthtimeMs > tsMs;
			if (createdAfter) {
				added.push(entry);
			} else {
				modified.push(entry);
			}
		}
	}
	// Stable order: by id ascending.
	added.sort((a, b) => a.id.localeCompare(b.id));
	modified.sort((a, b) => a.id.localeCompare(b.id));
	return { added, modified, deleted: [], ts: tsIso, note: SINCE_GRANULARITY_NOTE };
}

const CUSTOM_ID_LINE_RE = /^\s*:CUSTOM_ID:\s+(\S+)\s*$/m;

/**
 * Extract the first `:CUSTOM_ID:` from an org file; fall back to a derived id
 * shaped like `<KIND>-<filename-without-ext>` when the drawer is missing.
 */
async function extractFirstCustomId(file: string, kind: string, basename: string): Promise<string> {
	try {
		const text = await Bun.file(file).text();
		const m = CUSTOM_ID_LINE_RE.exec(text);
		if (m?.[1]) return m[1];
	} catch {
		// fall through to derived id
	}
	const stem = basename.endsWith(".org") ? basename.slice(0, -4) : basename;
	const prefix = kind === "episodes" ? "EP" : kind === "concepts" ? "CON" : kind === "playbooks" ? "PB" : "DEC";
	return `${prefix}-${stem}`;
}

interface MemoryCallPreview {
	description: string;
	meta: string[];
}

function buildMemoryCallPreview(args: MemoryParams): MemoryCallPreview {
	const meta: string[] = [];
	switch (args.action) {
		case "search":
			pushMeta(meta, "text", args.text);
			if (args.scope?.length) pushMeta(meta, "scope", args.scope.join(","), TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "focus", args.focus, TRUNCATE_LENGTHS.SHORT);
			if (typeof args.limit === "number") meta.push(`limit:${args.limit}`);
			pushMeta(meta, "profile", args.profile, TRUNCATE_LENGTHS.SHORT);
			break;
		case "about":
			pushMeta(meta, "id", args.id ?? args.focus, TRUNCATE_LENGTHS.SHORT);
			break;
		case "neighbors":
			pushMeta(meta, "focus", args.focus ?? args.id, TRUNCATE_LENGTHS.SHORT);
			if (typeof args.hops === "number") meta.push(`hops:${args.hops}`);
			if (args.kinds?.length) pushMeta(meta, "kinds", args.kinds.join(","), TRUNCATE_LENGTHS.SHORT);
			break;
		case "note":
			pushMeta(meta, "text", args.text);
			break;
		case "save":
			pushMeta(meta, "kind", args.kind, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "title", args.title);
			break;
		case "link":
			pushMeta(meta, "from", args.from, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "to", args.to, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "kind", args.kind, TRUNCATE_LENGTHS.SHORT);
			break;
		case "since":
			pushMeta(meta, "ts", typeof args.ts === "number" ? String(args.ts) : args.ts, TRUNCATE_LENGTHS.SHORT);
			break;
	}
	return { description: args.action, meta };
}

function pushMeta(meta: string[], label: string, value: unknown, width: number = TRUNCATE_LENGTHS.CONTENT): void {
	if (typeof value !== "string" || value.trim().length === 0) return;
	meta.push(truncateToWidth(`${label}:${replaceTabs(value).trim()}`, width));
}

/**
 * Compact action-aware result formatter. Mirrors org tool's style: small
 * line-oriented summaries for the common shapes, JSON fallback otherwise.
 */
export function formatMemoryResult(result: unknown, action: MemoryAction): string {
	if (!result || typeof result !== "object") return JSON.stringify(result, null, 2);
	const record = result as Record<string, unknown>;
	switch (action) {
		case "search": {
			const hits = Array.isArray(record.hits) ? (record.hits as Array<Record<string, unknown>>) : [];
			if (hits.length === 0) return "hits: 0";
			const lines = [`hits: ${hits.length}`];
			for (const hit of hits.slice(0, 20)) {
				const id = typeof hit.id === "string" ? hit.id : "?";
				const score = typeof hit.score === "number" ? hit.score.toFixed(3) : "";
				const title = typeof hit.title === "string" ? ` ${hit.title}` : "";
				lines.push(`- ${id}${score ? ` (${score})` : ""}${title}`);
			}
			if (hits.length > 20) lines.push(`[${hits.length - 20} more hits hidden]`);
			return lines.join("\n");
		}
		case "about": {
			const node = record.node as { id?: string; title?: string; kind?: string } | undefined;
			const neighbors = Array.isArray(record.neighbors) ? (record.neighbors as Array<Record<string, unknown>>) : [];
			const lineage = Array.isArray(record.lineage) ? (record.lineage as string[]) : [];
			const lines: string[] = [];
			if (node?.id) lines.push(`node: ${node.id}${node.title ? ` ${node.title}` : ""}`);
			lines.push(`neighbors: ${neighbors.length}`);
			for (const n of neighbors.slice(0, 20)) {
				const nid = typeof n.id === "string" ? n.id : "?";
				const nk = typeof n.kind === "string" ? ` ${n.kind}` : "";
				const via = typeof n.via === "string" ? ` (${n.via})` : "";
				lines.push(`- ${nid}${nk}${via}`);
			}
			if (neighbors.length > 20) lines.push(`[${neighbors.length - 20} more neighbors hidden]`);
			if (lineage.length > 0) lines.push(`lineage: ${lineage.join(", ")}`);
			return lines.join("\n");
		}
		case "neighbors": {
			const nodes = Array.isArray(record.nodes) ? (record.nodes as Array<Record<string, unknown>>) : [];
			const edges = Array.isArray(record.edges) ? (record.edges as Array<Record<string, unknown>>) : [];
			const lines = [`nodes: ${nodes.length}`, `edges: ${edges.length}`];
			for (const node of nodes.slice(0, 20)) {
				const id = typeof node.id === "string" ? node.id : "?";
				const title = typeof node.title === "string" ? ` ${node.title}` : "";
				lines.push(`- ${id}${title}`);
			}
			if (nodes.length > 20) lines.push(`[${nodes.length - 20} more nodes hidden]`);
			return lines.join("\n");
		}
		case "note":
		case "save": {
			const parts: string[] = [];
			if (record.id) parts.push(`id: ${String(record.id)}`);
			if (record.file) parts.push(`file: ${String(record.file)}`);
			if (record.kind) parts.push(`kind: ${String(record.kind)}`);
			return parts.length > 0 ? parts.join("\n") : JSON.stringify(record, null, 2);
		}
		case "link": {
			const parts: string[] = [];
			if (typeof record.revision === "number") parts.push(`revision: ${record.revision}`);
			if (record.file) parts.push(`file: ${String(record.file)}`);
			return parts.length > 0 ? parts.join("\n") : JSON.stringify(record, null, 2);
		}
		case "since": {
			const added = Array.isArray(record.added) ? record.added.length : 0;
			const modified = Array.isArray(record.modified) ? record.modified.length : 0;
			const deleted = Array.isArray(record.deleted) ? record.deleted.length : 0;
			const lines = [`added: ${added}`, `modified: ${modified}`, `deleted: ${deleted}`];
			if (typeof record.note === "string") lines.push(`note: ${record.note}`);
			return lines.join("\n");
		}
	}
}
