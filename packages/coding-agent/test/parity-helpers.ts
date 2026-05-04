import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { CodePathChunk, NodeRefDto } from "@oh-my-pi/pi-natives/code-path";
import { Snowflake } from "@oh-my-pi/pi-utils";

// ── fixture helpers ──────────────────────────────────────────────

export function setupFixtureDir(): string {
	const dir = path.join(os.tmpdir(), `parity-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function teardownFixtureDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

export function writeFiles(dir: string, files: Record<string, string>): void {
	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = path.join(dir, relPath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content);
	}
}

// ── result helpers ───────────────────────────────────────────────

export function flattenChunks(chunks: CodePathChunk[]): NodeRefDto[] {
	return chunks.flatMap(c => c.nodes);
}

export function collectDiagnostics(chunks: CodePathChunk[]) {
	return chunks.flatMap(c => c.diagnostics);
}

export function getNodeText(node: NodeRefDto): string | undefined {
	return node.content?.text ?? node.content?.value ?? undefined;
}

export function getNodePaths(nodes: NodeRefDto[]): string[] {
	return nodes.map(n => {
		// Extract bare path from locator (remove query/qualifier suffixes)
		const m = n.locator.match(/^(.+?)(?:::|<|@|#)/);
		return m ? m[1] : n.locator;
	});
}

// ── semantic comparison helpers ──────────────────────────────────

/** Compare file lists ignoring order. */
export function expectFilesEqual(a: string[], b: string[]): void {
	expect(new Set(a)).toEqual(new Set(b));
}

/** Compare `{path, line, col}` matches normalising paths. */
export function expectMatchesEqual(
	a: Array<{ path: string; line?: number; col?: number }>,
	b: Array<{ path: string; line?: number; col?: number }>,
): void {
	const norm = (xs: typeof a) =>
		xs
			.map(x => ({
				path: path.basename(x.path),
				line: x.line ?? 0,
				col: x.col ?? 0,
			}))
			.sort((x, y) => `${x.path}:${x.line}:${x.col}`.localeCompare(`${y.path}:${y.line}:${y.col}`));
	expect(norm(a)).toEqual(norm(b));
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n+/g, "\n").trim();
}

/** Compare text content with whitespace normalisation. */
export function expectTextEqual(a: string, b: string): void {
	expect(normalizeWhitespace(a)).toBe(normalizeWhitespace(b));
}

/** Compare extracted text with whitespace-norm + optional leading/trailing tolerance. */
export function expectExtractedTextEqual(a: string, b: string, tolerance?: "trim" | "normalize"): void {
	let na = normalizeWhitespace(a);
	let nb = normalizeWhitespace(b);
	if (tolerance === "trim") {
		na = na.replace(/^\s+|\s+$/g, "");
		nb = nb.replace(/^\s+|\s+$/g, "");
	}
	expect(na).toBe(nb);
}

// ── tool dispatch wrappers ───────────────────────────────────────

export async function runGet(
	target: string,
	opts?: { limit?: number; head?: number; tail?: number; offset?: number; format?: string; root?: string },
): Promise<CodePathChunk[]> {
	return executeCodePath({ command: "get", target, ...opts });
}

export async function runEdit(
	operations: Array<{ target?: string; action: Record<string, unknown>; children?: unknown[] }>,
	opts?: { root?: string },
): Promise<CodePathChunk[]> {
	return executeCodePath({ command: "edit", actions: operations, ...opts });
}

export async function runManage(command: string, file?: string, root?: string): Promise<CodePathChunk[]> {
	return executeCodePath({ command: "manage", manage: command, target: file ?? "", root });
}

export async function runCreate(
	filePath: string,
	content: string,
	opts?: { force?: boolean; root?: string },
): Promise<CodePathChunk[]> {
	return executeCodePath({
		command: "edit",
		target: filePath,
		actions: [{ kind: "create", content, force: opts?.force }],
		root: opts?.root,
	});
}
