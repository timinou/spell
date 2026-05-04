import type { CodePathChunk, DiagnosticDto, NodeRefDto } from "./codepath-types";
import { applyListLimit, type ListLimitOptions } from "./list-limit";
import { outputMeta } from "./output-meta";

export type CodePathFormatMode = "node-list" | "locations" | "content-only" | "tree" | "simple-list";

export interface CodePathResultOptions {
	format?: CodePathFormatMode;
	limit?: number;
	headLimit?: number;
}

export interface CodePathResult {
	text: string;
	meta?: ReturnType<typeof outputMeta>["get"] extends () => infer R ? R : never;
	images: Array<{ data: string; mimeType: string; text?: string }>;
}

function formatLocator(locator: string): { path?: string; line?: number; column?: number } {
	// locator shapes: "path", "path:line", "path:line:col", "path@line:col"
	const match = locator.match(/^(.+?)(?::(\d+)(?::(\d+))?)?$/);
	if (!match) return { path: locator };
	return {
		path: match[1],
		line: match[2] ? Number(match[2]) : undefined,
		column: match[3] ? Number(match[3]) : undefined,
	};
}

function nodeToLocation(node: NodeRefDto): string {
	const { path, line, column } = formatLocator(node.locator);
	if (line !== undefined && column !== undefined) return `${path}:${line}:${column}`;
	if (line !== undefined) return `${path}:${line}`;
	return path ?? node.locator;
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

function buildNodeList(nodes: NodeRefDto[]): string {
	return nodes
		.map(node => {
			const loc = nodeToLocation(node);
			const text = getNodeText(node);
			const kind = getNodeKindLabel(node);
			if (text !== undefined) {
				return `${loc}  [${kind}]\n${text}`;
			}
			return `${loc}  [${kind}]`;
		})
		.join("\n\n");
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

function extractImages(nodes: NodeRefDto[]): Array<{ data: string; mimeType: string; text?: string }> {
	const images: Array<{ data: string; mimeType: string; text?: string }> = [];
	for (const node of nodes) {
		const content = node.content;
		if (content && content.kind === "image" && content.value && content.mimeType) {
			images.push({ data: content.value, mimeType: content.mimeType, text: content.text });
		}
	}
	return images;
}

function collectAllNodes(chunks: CodePathChunk[]): NodeRefDto[] {
	return chunks.flatMap(c => c.nodes);
}

function collectDiagnostics(chunks: CodePathChunk[]): DiagnosticDto[] {
	return chunks.flatMap(c => c.diagnostics);
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
		default:
			text = buildNodeList(nodes);
			break;
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
	};
}
