import type { CodePathChunk, DiagnosticDto, NodeRefDto } from "./codepath-types";
import { applyListLimit, type ListLimitOptions } from "./list-limit";
import { outputMeta } from "./output-meta";

export type CodePathFormatMode = "node-list" | "locations" | "content-only" | "tree" | "simple-list" | "fs-listing";

export interface CodePathResultOptions {
	format?: CodePathFormatMode;
	limit?: number;
	headLimit?: number;
}

/**
 * FEAT-786: quantitative summary of a CodePath result, computed post-limit.
 * Surfaced into tool `details` so the TUI renderer can build a meta line
 * ("N files · M matches") without re-parsing the rendered text.
 */
export interface CodePathStats {
	/** Total nodes after limit application. */
	nodeCount: number;
	/** Subset that are grep match-shape §line nodes. */
	matchCount: number;
	/** Distinct file paths across all nodes. */
	fileCount: number;
}

export interface CodePathResult {
	text: string;
	meta?: ReturnType<typeof outputMeta>["get"] extends () => infer R ? R : never;
	images: Array<{ data: string; mimeType: string; text?: string; skipImageBlock?: boolean }>;
	stats: CodePathStats;
	/**
	 * Machine PAYLOAD projection of the result nodes (FEAT-789 `data` channel).
	 * A flat, JSON-clean list a programmatic consumer (the `execute` coprocessor)
	 * can read directly — locator, kind, resolved path/line, and node text —
	 * instead of re-parsing the rendered `text`. This is what makes `get`/`find`
	 * programmatically readable (file content + grep hits), not just a render
	 * summary.
	 */
	data: CodePathNodeData[];
}

/** One node in the machine payload projection (FEAT-789). */
export interface CodePathNodeData {
	/** Raw kernel locator (e.g. `src/foo.ts:42#A1`). */
	locator: string;
	/** Node kind (`§file`, `§line`, `§function`, …). */
	kind: string;
	/** Resolved file path, when the locator encodes one. */
	path?: string;
	/** 1-indexed line, when the locator encodes one. */
	line?: number;
	/** Node text/content when present (file slice, grep line, symbol body). */
	text?: string;
}

function formatLocator(locator: string): {
	path?: string;
	line?: number;
	column?: number;
	anchorId?: string;
} {
	// FEAT-705: text-axis line locators arrive as
	// `path::<line N#ID>` from the resolver. Strip the angle-bracket
	// envelope and split on `#` for the deterministic anchor id.
	const newLineMatch = locator.match(/^(.+?)(?:::?)<line (\d+)(?:#([A-Z0-9]{2}))?>$/);
	if (newLineMatch) {
		return {
			path: newLineMatch[1],
			line: Number(newLineMatch[2]),
			anchorId: newLineMatch[3],
		};
	}
	// Legacy shapes: "path", "path:line", "path:line:col"
	const match = locator.match(/^(.+?)(?::(\d+)(?::(\d+))?)?$/);
	if (!match) return { path: locator };
	return {
		path: match[1],
		line: match[2] ? Number(match[2]) : undefined,
		column: match[3] ? Number(match[3]) : undefined,
	};
}

function nodeToLocation(node: NodeRefDto): string {
	const { path, line, column, anchorId } = formatLocator(node.locator);
	const stat = formatStatMetadata(node);
	const suffix = stat ?? "";
	// FEAT-705: when we have a deterministic anchor id, render it next
	// to the line so the agent can copy `LINE#ID` straight back as a
	// pos/end anchor on edit actions.
	if (line !== undefined && anchorId) return `${path}:${line}#${anchorId}${suffix}`;
	if (line !== undefined && column !== undefined) return `${path}:${line}:${column}${suffix}`;
	if (line !== undefined) return `${path}:${line}${suffix}`;
	return (path ?? node.locator) + suffix;
}

function getNodeText(node: NodeRefDto): string | undefined {
	const content = node.content;
	if (!content) return undefined;
	if (content.text) return content.text;
	if (content.value) return content.value;
	return undefined;
}

function getNodeKindLabel(node: NodeRefDto): string {
	return node.kind ?? "node";
}

function localFormatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1)} MB`;
	return `${(mb / 1024).toFixed(2)} GB`;
}

function formatStatMetadata(node: NodeRefDto): string | null {
	// FEAT-709: surface size + mtime on §file/§dir/§symlink stat results
	// so `get(target:"…#stat")` is informative instead of bare-path.
	if (!["§file", "§dir", "§symlink", "§outline"].includes(node.kind)) return null;
	const meta = (node.metadata ?? {}) as Record<string, unknown>;
	const sizeRaw = meta.size;
	const mtimeRaw = meta.mtime;
	const parts: string[] = [];
	if (typeof sizeRaw === "number" && sizeRaw > 0) parts.push(`size=${localFormatBytes(sizeRaw)}`);
	if (typeof mtimeRaw === "number") {
		const iso = new Date(mtimeRaw * 1000).toISOString();
		parts.push(`mtime=${iso}`);
	}
	if (typeof meta.target === "string") parts.push(`target=${meta.target}`);
	if (typeof meta.lineCount === "number") parts.push(`lineCount=${meta.lineCount}`);
	if (parts.length === 0) return null;
	return ` [${node.kind} ${parts.join(" ")}]`;
}

function formatDiagnostic(d: DiagnosticDto): string {
	const span = d.span ? ` (${d.span.start}-${d.span.end})` : "";
	return `[${d.variant}] ${d.message}${span}`;
}

function buildTreeNodes(nodes: NodeRefDto[]): string {
	const byPath = new Map<string, NodeRefDto[]>();
	for (const node of nodes) {
		const { path } = formatLocator(node.locator);
		const key = path ?? node.locator;
		byPath.set(key, [...(byPath.get(key) ?? []), node]);
	}
	const lines: string[] = [];
	for (const [path, fileNodes] of byPath) {
		lines.push(path);
		for (const node of fileNodes) {
			const loc = nodeToLocation(node);
			lines.push(`  ${loc}  ${getNodeKindLabel(node)}`);
		}
	}
	return lines.join("\n");
}

function getManagePayloadText(node: NodeRefDto): string | undefined {
	if (node.kind !== "§manage-result") return undefined;
	const payload = (node.metadata as Record<string, unknown> | undefined)?.payload;
	if (payload === null || payload === undefined) return undefined;
	if (typeof payload === "string") return payload;
	if (typeof payload === "object") {
		try {
			return JSON.stringify(payload, null, 2);
		} catch {
			return undefined;
		}
	}
	return undefined;
}
function isMatchShapeNode(node: NodeRefDto): boolean {
	return (node.metadata as Record<string, unknown> | undefined)?.shape === "match";
}

interface MatchRow {
	path: string;
	line: number | undefined;
	content: string;
}

function matchRow(node: NodeRefDto): MatchRow {
	const { path, line } = formatLocator(node.locator);
	const raw = getNodeText(node) ?? "";
	return {
		path: path ?? node.locator,
		line,
		content: raw.replace(/\r?\n$/, ""),
	};
}

/**
 * FEAT-785: render predicate-matched §line nodes in ripgrep `--heading` shape —
 * each file path emitted once as a heading, hits indented beneath as
 * `  <line>:  <content>`. Replaces the FEAT-719 per-row `path:line:  content`
 * shape that re-emitted the full path on every hit (N matches → N path repeats).
 *
 * Pure grouping: single-hit files also get a heading so the model parses one
 * shape (heading = bare `^\S` line; hit = `^  <digits>:`). The line number
 * stays machine-parsable so `edit` can recompose `path::§line[N]`; the path
 * lives in the heading. LINE#ID anchors are intentionally omitted — anchor
 * lookup is the ordinal form `§line[N]`.
 */
function renderMatchGroups(nodes: NodeRefDto[]): string {
	const rows = nodes.map(matchRow);
	const blocks: string[] = [];
	let i = 0;
	while (i < rows.length) {
		const path = rows[i].path;
		const lines = [path];
		while (i < rows.length && rows[i].path === path) {
			const { line, content } = rows[i];
			lines.push(line !== undefined ? `  ${line}:  ${content}` : `  ${content}`);
			i++;
		}
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n\n");
}

function compareMatchNodes(a: NodeRefDto, b: NodeRefDto): number {
	const la = formatLocator(a.locator);
	const lb = formatLocator(b.locator);
	const pa = la.path ?? "";
	const pb = lb.path ?? "";
	if (pa !== pb) return pa < pb ? -1 : 1;
	return (la.line ?? 0) - (lb.line ?? 0);
}

function buildNodeList(nodes: NodeRefDto[]): string {
	// Partition match-shape lines so the contiguous grep block renders together,
	// preserves cross-file ordering, and can't be visually broken up by other
	// node kinds in the same chunk batch.
	const out: string[] = [];
	let matchBuf: NodeRefDto[] = [];
	const flushMatches = () => {
		if (matchBuf.length === 0) return;
		const sorted = [...matchBuf].sort(compareMatchNodes);
		out.push(renderMatchGroups(sorted));
		matchBuf = [];
	};
	for (const node of nodes) {
		if (isMatchShapeNode(node)) {
			matchBuf.push(node);
			continue;
		}
		flushMatches();
		const loc = nodeToLocation(node);
		const text = getManagePayloadText(node) ?? getNodeText(node);
		const kind = getNodeKindLabel(node);
		if (text !== undefined) {
			out.push(`${loc}  [${kind}]\n${text}`);
		} else {
			out.push(`${loc}  [${kind}]`);
		}
	}
	flushMatches();
	return out.join("\n\n");
}

function buildLocations(nodes: NodeRefDto[]): string {
	return nodes.map(nodeToLocation).join("\n");
}

function buildContentOnly(nodes: NodeRefDto[]): string {
	return nodes
		.map(n => getNodeText(n))
		.filter((t): t is string => t !== undefined)
		.join("\n\n");
}

function buildSimpleList(nodes: NodeRefDto[]): string {
	const paths = new Set<string>();
	for (const node of nodes) {
		const { path } = formatLocator(node.locator);
		paths.add(path ?? node.locator);
	}
	return [...paths].join("\n");
}

// Kernel emits §-prefixed kinds (§file/§dir/§symlink) plus the bare `stat`
// kind from #stat. Accept both prefixed and unprefixed spellings so the
// auto-promotion gate fires on real resolver output (previously only matched
// the unprefixed test fixtures, so live #tree fell through to node-list).
const FS_KINDS = new Set(["file", "dir", "symlink", "stat", "§file", "§dir", "§symlink"]);

function allFsNodes(nodes: NodeRefDto[]): boolean {
	// A walk may interleave §inaccessible sentinels (permission denied, transient
	// IO) among real fs nodes; tolerate them so one unreadable entry doesn't
	// demote the whole tree back to the flat node-list shape. Require at least one
	// genuine fs node so an all-error result still routes to node-list (where the
	// diagnostics render).
	//
	// A node carrying text content is a *content* read (#raw, or a bare file read
	// whose §file node holds the source) — NOT a structural listing. Those must
	// stay on the node-list path so the content renders; fs-listing only shows
	// `path  size`. So any content-bearing node disqualifies auto-promotion.
	if (nodes.length === 0) return false;
	let sawFs = false;
	for (const n of nodes) {
		if (getNodeText(n) !== undefined) return false;
		if (FS_KINDS.has(n.kind)) {
			sawFs = true;
		} else if (bareKind(n.kind) !== "inaccessible") {
			return false;
		}
	}
	return sawFs;
}

function formatSize(bytes: unknown): string {
	if (typeof bytes !== "number" || bytes < 0) return "";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** Strip a leading `§` from a node kind so `§dir` and `dir` compare equal. */
function bareKind(kind: string): string {
	return kind.startsWith("§") ? kind.slice(1) : kind;
}

/** Walk depth carried by the resolver (root = 0). Absent → treated as flat. */
function nodeDepth(node: NodeRefDto): number | undefined {
	const d = (node.metadata as Record<string, unknown> | undefined)?.depth;
	return typeof d === "number" ? d : undefined;
}

/** Basename carried by the resolver; falls back to the locator's last segment. */
function nodeName(node: NodeRefDto): string {
	const n = (node.metadata as Record<string, unknown> | undefined)?.name;
	if (typeof n === "string" && n.length > 0) return n;
	const { path } = formatLocator(node.locator);
	const p = path ?? node.locator;
	const slash = p.lastIndexOf("/");
	return slash >= 0 ? p.slice(slash + 1) : p;
}

/** File byte size: resolver encodes it as the node range width. */
function nodeSize(node: NodeRefDto): number | undefined {
	const meta = (node.metadata as Record<string, unknown> | undefined)?.size;
	if (typeof meta === "number") return meta;
	const start = (node as unknown as { rangeStart?: number }).rangeStart;
	const end = (node as unknown as { rangeEnd?: number }).rangeEnd;
	if (typeof start === "number" && typeof end === "number" && end >= start) return end - start;
	return undefined;
}

/**
 * Render a filesystem result.
 *
 * Two shapes, chosen by whether the nodes carry `depth` metadata:
 *
 * 1. **Indented tree** (`#tree` / `#listing` — depth present): each entry is
 *    indented by its walk depth and shown by basename only, so structure reads
 *    at a glance instead of repeating the full path on every row. Directories
 *    get a trailing `/`, symlinks `@`, files an optional right-aligned size.
 *    The base (depth 0) node is the header; its full path anchors the subtree.
 *
 * 2. **Flat list** (`#stat`, or fs nodes without depth): one line per node with
 *    the full locator + metadata, preserving the prior stat/listing shape.
 */
function buildFsListing(nodes: NodeRefDto[]): string {
	const hasDepth = nodes.some(n => nodeDepth(n) !== undefined);
	if (hasDepth) return buildFsTree(nodes);

	const lines: string[] = [];
	for (const node of nodes) {
		const loc = nodeToLocation(node);
		const kind = bareKind(node.kind);
		if (kind === "stat") {
			const parts: string[] = [loc];
			const meta = (node.metadata ?? {}) as Record<string, unknown>;
			if (meta.size !== undefined) parts.push(`size=${meta.size}`);
			if (meta.mtime) parts.push(`mtime=${meta.mtime}`);
			if (meta.kind) {
				parts.push(`kind=${meta.kind}`);
			} else {
				parts.push("kind=§stat");
			}
			lines.push(parts.join("  "));
		} else if (kind === "dir") {
			lines.push(`${loc}/`);
		} else if (kind === "symlink") {
			lines.push(`${loc}@`);
		} else {
			const size = nodeSize(node);
			const sizeStr = size !== undefined ? `  ${formatSize(size)}` : "";
			lines.push(`${loc}${sizeStr}`);
		}
	}
	return lines.join("\n");
}

/**
 * Indented tree render. Depth 0 (the walk base) becomes a path header; deeper
 * entries are indented two spaces per level and shown by basename. Inaccessible
 * entries surface inline so a permission error is visible, not silently
 * dropped.
 */
function buildFsTree(nodes: NodeRefDto[]): string {
	if (nodes.length === 0) return "";
	// Minimum depth anchors the indentation (a #listing starts its children at
	// depth 1; a #tree includes the depth-0 base). Indent relative to it.
	const depths = nodes.map(n => nodeDepth(n) ?? 0);
	const baseDepth = Math.min(...depths);
	const lines: string[] = [];
	for (const node of nodes) {
		const kind = bareKind(node.kind);
		if (kind === "inaccessible") {
			const { path } = formatLocator(node.locator);
			lines.push(`${path ?? node.locator}  ⟨inaccessible⟩`);
			continue;
		}
		const depth = nodeDepth(node) ?? 0;
		const rel = Math.max(0, depth - baseDepth);
		const indent = "  ".repeat(rel);
		const name = nodeName(node);
		if (kind === "dir") {
			lines.push(`${indent}${name}/`);
		} else if (kind === "symlink") {
			lines.push(`${indent}${name}@`);
		} else {
			const size = nodeSize(node);
			const sizeStr = size !== undefined && size > 0 ? `  ${formatSize(size)}` : "";
			lines.push(`${indent}${name}${sizeStr}`);
		}
	}
	return lines.join("\n");
}

function extractImages(
	nodes: NodeRefDto[],
): Array<{ data: string; mimeType: string; text?: string; skipImageBlock?: boolean }> {
	const images: Array<{ data: string; mimeType: string; text?: string; skipImageBlock?: boolean }> = [];
	for (const node of nodes) {
		const content = node.content;
		if (!content || content.kind !== "image" || !content.mimeType) continue;
		if (content.value) {
			images.push({ data: content.value, mimeType: content.mimeType, text: content.text });
		} else if (content.artifactUri) {
			// Image bytes externalized but no JS resolver for the URI namespace.
			// Emit a text-only entry; never put a URI into the data field.
			images.push({
				data: "",
				mimeType: content.mimeType,
				text: `[image unavailable: bytes externalized to ${content.artifactUri}]`,
				skipImageBlock: true,
			});
		} else if (content.handle) {
			// Kernel #image qualifier omits inline bytes for oversized rasters
			// (>512KiB), leaving a handle-only node. Surface a marker instead of
			// silently dropping the image so the model knows it exists and how to
			// view it. (Bare-path image reads bypass this by loading via the read
			// path, which resizes; this only fires on an explicit `…#image`.)
			images.push({
				data: "",
				mimeType: content.mimeType,
				text: `[image too large to inline (${content.mimeType}${content.width && content.height ? `, ${content.width}×${content.height}` : ""}); read the bare path to get a resized, viewable version]`,
				skipImageBlock: true,
			});
		}
	}
	return images;
}

function collectAllNodes(chunks: CodePathChunk[]): NodeRefDto[] {
	return chunks.flatMap(c => c.nodes);
}

function collectDiagnostics(chunks: CodePathChunk[]): DiagnosticDto[] {
	const nodeDiags = chunks.flatMap(c => c.nodes.flatMap(n => n.diagnostics ?? []));
	const chunkDiags = chunks.flatMap(c => c.diagnostics);
	return [...nodeDiags, ...chunkDiags];
}

/**
 * Format a stream of CodePathChunk results into a display representation.
 */
export function formatCodePathResult(chunks: CodePathChunk[], options: CodePathResultOptions = {}): CodePathResult {
	const mode: CodePathFormatMode = options.format ?? "node-list";
	let nodes = collectAllNodes(chunks);
	const diagnostics = collectDiagnostics(chunks);

	const limitOpts: ListLimitOptions = {
		limit: options.limit,
		headLimit: options.headLimit,
		limitType: "result",
	};
	const limited = applyListLimit(nodes, limitOpts);
	nodes = limited.items;

	let text: string;
	switch (mode) {
		case "locations":
			text = buildLocations(nodes);
			break;
		case "content-only":
			text = buildContentOnly(nodes);
			break;
		case "tree":
			text = buildTreeNodes(nodes);
			break;
		case "simple-list":
			text = buildSimpleList(nodes);
			break;
		case "fs-listing":
			text = buildFsListing(nodes);
			break;
		default:
			// Auto-promote to fs-listing only when format is unset (not explicit).
			if (options.format === undefined && allFsNodes(nodes)) {
				text = buildFsListing(nodes);
			} else {
				text = buildNodeList(nodes);
			}
			break;
	}

	// Degenerate-result hint: a bare directory target resolves to a single dir
	// marker (no qualifier → no walk). Suggest #tree / #listing. Prefix-tolerant
	// so it fires on the kernel's §dir as well as bare-`dir` test fixtures.
	if (
		nodes.length === 1 &&
		bareKind(nodes[0].kind) === "dir" &&
		nodeDepth(nodes[0]) === undefined &&
		(text === `${nodes[0].locator}/` || text === `${nodeName(nodes[0])}/`)
	) {
		text +=
			"\n\n(hint: single directory marker — use recursive: true or depth for recursive listing, or content: false to suppress)";
	}

	// Empty directory placeholder.
	if (options.format === undefined && nodes.length === 0 && text === "") {
		text = "(no entries)";
	}

	if (diagnostics.length > 0) {
		text += `\n\nDiagnostics:\n${diagnostics.map(formatDiagnostic).join("\n")}`;
	}

	const metaBuilder = outputMeta();
	if (limited.meta.resultLimit) {
		metaBuilder.limits({ resultLimit: limited.meta.resultLimit.reached });
	}
	if (limited.meta.headLimit) {
		metaBuilder.limits({ headLimit: limited.meta.headLimit.reached });
	}

	return {
		text,
		meta: metaBuilder.get(),
		images: extractImages(nodes),
		stats: computeStats(nodes),
		data: projectNodeData(nodes),
	};
}

/**
 * Project result nodes into the machine PAYLOAD shape (FEAT-789 `data`).
 * Flat, JSON-clean, post-limit — mirrors exactly what the renderer saw so a
 * program reads the same node set the model sees, minus the formatting.
 */
function projectNodeData(nodes: NodeRefDto[]): CodePathNodeData[] {
	return nodes.map(node => {
		const { path, line } = formatLocator(node.locator);
		const text = getNodeText(node);
		const out: CodePathNodeData = { locator: node.locator, kind: node.kind };
		if (path !== undefined) out.path = path;
		if (line !== undefined) out.line = line;
		if (text !== undefined) out.text = text;
		return out;
	});
}

function computeStats(nodes: NodeRefDto[]): CodePathStats {
	const paths = new Set<string>();
	let matchCount = 0;
	for (const node of nodes) {
		if (isMatchShapeNode(node)) matchCount++;
		const { path } = formatLocator(node.locator);
		paths.add(path ?? node.locator);
	}
	return { nodeCount: nodes.length, matchCount, fileCount: paths.size };
}
