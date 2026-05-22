/**
 * Memory tool — unified surface for recall, save, link, and graph traversal.
 *
 * Wraps the native executeOrg memory commands (recall · remember · subgraph ·
 * link · timeline) under a single action-discriminated tool. Replaces the five
 * org subcommands that were deleted in PLAN-310 W6.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
} from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

	// search / about / neighbors / since
	text: Type.Optional(Type.String({ description: "FTS query (search)" })),
	id: Type.Optional(Type.String({ description: "Item id (about) or focus fallback (neighbors)" })),
	scope: Type.Optional(
		Type.Array(Type.String(), {
			description: "Kind filter: episode, concept, playbook, decision, entity, actor, workflow",
		}),
	),
	focus: Type.Optional(Type.String({ description: "Graph focus node id (search, neighbors)" })),
	hops: Type.Optional(Type.Number({ description: "Graph hop depth (default 1)" })),
	kinds: Type.Optional(Type.Array(Type.String(), { description: "Edge kind filter (neighbors)" })),
	limit: Type.Optional(Type.Number({ description: "Max hits (search)" })),
	profile: Type.Optional(Type.String({ description: "Recall profile name (search)" })),
	includePersonal: Type.Optional(Type.Boolean({ description: "Include personal-store memories (search)" })),
	ts: Type.Optional(Type.String({ description: "ISO-8601 timestamp (since)" })),

	// note
	note_text: Type.Optional(Type.String({ description: "Episode summary (note)" })),
	note_about: Type.Optional(Type.Array(Type.String(), { description: "ABOUT edges (note)" })),
	note_involved: Type.Optional(Type.Array(Type.String(), { description: "INVOLVED edges (note)" })),

	// save
	save_kind: Type.Optional(
		Type.String({ description: "Kind: concept | playbook | decision | episode (save)" }),
	),
	title: Type.Optional(Type.String({ description: "Title (save)" })),
	body: Type.Optional(Type.String({ description: "Body (save)" })),
	distilled_from: Type.Optional(Type.Array(Type.String(), { description: "DISTILLED_FROM edges (save)" })),
	relations: Type.Optional(
		Type.Array(
			Type.Object({ kind: Type.String(), target: Type.String() }),
			{ description: "Additional typed edges (save)" },
		),
	),

	// link
	from: Type.Optional(Type.String({ description: "Source id (link)" })),
	to: Type.Optional(Type.String({ description: "Target id (link)" })),
	link_kind: Type.Optional(Type.String({ description: "Edge kind (link)" })),

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
const SINCE_GRANULARITY_NOTE =
	"granularity: file-mtime only; added/deleted deferred — see PLAN-310 W7";

export class MemoryTool implements AgentTool<typeof memorySchema, MemoryDetails, Theme> {
	readonly name = "memory";
	readonly label = "Memory";
	readonly description = memoryDescription;
	readonly parameters = memorySchema;
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
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const repoRoot = this.#session.cwd ?? getProjectDir();
		try {
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
 * Dispatch a memory `action` to the right executeOrg command. Pure, exported
 * for unit tests.
 */
export async function dispatchMemoryAction(params: MemoryParams, repoRoot: string): Promise<unknown> {
	switch (params.action) {
		case "search": {
			const result = executeOrg({
				command: "recall",
				text: params.text,
				scope: params.scope,
				focus: params.focus,
				graphHops: params.hops,
				limit: params.limit,
				includePersonal: params.includePersonal,
				profile: params.profile,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "about": {
			const focusId = params.id ?? params.focus;
			if (!focusId) throw new Error("memory.about requires `id`");
			// subgraph(hops=1) returns the focus node + its 1-hop neighbours,
			// fulfilling the get+neighbours fusion the spec asks for.
			const result = executeOrg({
				command: "subgraph",
				root: focusId,
				hops: 1,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "neighbors": {
			const focusId = params.focus ?? params.id;
			if (!focusId) throw new Error("memory.neighbors requires `focus` or `id`");
			const result = executeOrg({
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
			if (!params.note_text) throw new Error("memory.note requires `note_text`");
			const result = executeOrg({
				command: "remember",
				kind: "episode",
				summary: params.note_text,
				about: params.note_about,
				involves: params.note_involved,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "save": {
			if (!params.save_kind) throw new Error("memory.save requires `save_kind`");
			if (!params.title) throw new Error("memory.save requires `title`");
			const summary = params.body ? `${params.title}\n\n${params.body}` : params.title;
			const aboutEdges = params.relations?.filter(r => r.kind === "ABOUT").map(r => r.target);
			const involvesEdges = params.relations?.filter(r => r.kind === "INVOLVED").map(r => r.target);
			const producedEdges = params.relations?.filter(r => r.kind === "PRODUCED").map(r => r.target);
			const supersedesEdges = params.relations?.filter(r => r.kind === "SUPERSEDES").map(r => r.target);
			const result = executeOrg({
				command: "remember",
				kind: params.save_kind,
				summary,
				distilledFrom: params.distilled_from,
				about: aboutEdges && aboutEdges.length > 0 ? aboutEdges : undefined,
				involves: involvesEdges && involvesEdges.length > 0 ? involvesEdges : undefined,
				produced: producedEdges && producedEdges.length > 0 ? producedEdges : undefined,
				supersedes: supersedesEdges && supersedesEdges.length > 0 ? supersedesEdges : undefined,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "link": {
			if (!params.from || !params.to || !params.link_kind) {
				throw new Error("memory.link requires `from`, `to`, and `link_kind`");
			}
			const result = executeOrg({
				command: "link",
				from: params.from,
				to: params.to,
				kind: params.link_kind,
				repoRoot,
			});
			if (result.error) throw new Error(String(result.output));
			return result.output;
		}
		case "since": {
			if (!params.ts) throw new Error("memory.since requires `ts`");
			return await diffMemorySince(repoRoot, params.ts);
		}
		default: {
			const exhaustive: never = params.action;
			throw new Error(`Unknown memory action: ${String(exhaustive)}`);
		}
	}
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
): Promise<{ added: unknown[]; modified: Array<{ id: string; file: string; mtime: string }>; deleted: unknown[]; ts: string; note: string }> {
	const tsMs = Date.parse(tsIso);
	if (!Number.isFinite(tsMs)) {
		throw new Error(`memory.since: invalid timestamp: ${tsIso}`);
	}
	const memoryRoot = path.join(repoRoot, ".spell", "memory");
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
			let stat: { mtimeMs: number };
			try {
				stat = await fs.stat(file);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw err;
			}
			if (stat.mtimeMs <= tsMs) continue;
			const id = await extractFirstCustomId(file, sub, name);
			modified.push({ id, file, mtime: new Date(stat.mtimeMs).toISOString() });
		}
	}
	// Stable order: by id ascending.
	modified.sort((a, b) => a.id.localeCompare(b.id));
	return { added: [], modified, deleted: [], ts: tsIso, note: SINCE_GRANULARITY_NOTE };
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
			pushMeta(meta, "text", args.note_text);
			break;
		case "save":
			pushMeta(meta, "kind", args.save_kind, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "title", args.title);
			break;
		case "link":
			pushMeta(meta, "from", args.from, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "to", args.to, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "kind", args.link_kind, TRUNCATE_LENGTHS.SHORT);
			break;
		case "since":
			pushMeta(meta, "ts", args.ts, TRUNCATE_LENGTHS.SHORT);
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
		case "about":
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
