import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeOrg } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

const DEFAULT_MEMORY_FILE = "memory_summary.md";
const ROOT_NAMESPACE = "root";
const SEARCH_NAMESPACE = "search";
const ITEM_NAMESPACE = "item";
const SINCE_NAMESPACE = "since";
const BROWSE_NAMESPACE = "browse";

const SINCE_STUB_NOTE = "since not yet implemented (PLAN-310 W7)";

/**
 * Options for the memory:// URL protocol.
 */
export interface MemoryProtocolOptions {
	/**
	 * Returns the absolute path to the current project's memory root.
	 */
	getMemoryRoot: () => string;
	/**
	 * Returns the absolute repo root used as `repoRoot` for executeOrg memory
	 * commands. Defaults to the memory root's parent's parent (i.e. project
	 * root inferred from `<project>/.spell/memory`).
	 */
	getRepoRoot?: () => string;
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("memory:// URL escapes memory root");
	}
}

function toMemoryValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "memory://"));
}

/**
 * Resolve a memory:// URL to an absolute filesystem path under memory root.
 * Only valid for `memory://root` and `memory://root/<path>` URLs.
 */
export function resolveMemoryUrlToPath(url: InternalUrl, memoryRoot: string): string {
	const namespace = url.rawHost || url.hostname;
	if (!namespace) {
		throw new Error("memory:// URL requires a namespace: memory://root");
	}
	if (namespace !== ROOT_NAMESPACE) {
		throw new Error(
			`Unknown memory namespace: ${namespace}. Supported: ${ROOT_NAMESPACE}, ${SEARCH_NAMESPACE}, ${ITEM_NAMESPACE}, ${SINCE_NAMESPACE}, ${BROWSE_NAMESPACE}`,
		);
	}

	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";
	if (!hasPath) {
		return path.resolve(memoryRoot, DEFAULT_MEMORY_FILE);
	}
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPathname.slice(1));
	} catch {
		throw new Error(`Invalid URL encoding in memory:// path: ${url.href}`);
	}

	try {
		validateRelativePath(relativePath);
	} catch (error) {
		throw toMemoryValidationError(error);
	}

	return path.resolve(memoryRoot, relativePath);
}

function parseScopeParam(raw: string | null): string[] | undefined {
	if (!raw) return undefined;
	const parts = raw
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);
	return parts.length > 0 ? parts : undefined;
}

function parseNumberParam(raw: string | null): number | undefined {
	if (raw === null) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function jsonResource(url: InternalUrl, payload: unknown, notes: readonly string[] = []): InternalResource {
	const content = JSON.stringify(payload, null, 2);
	return {
		url: url.href,
		content,
		contentType: "application/json",
		size: Buffer.byteLength(content, "utf-8"),
		notes,
	};
}

/**
 * Protocol handler for memory:// URLs.
 *
 * URL forms:
 * - `memory://root`                — memory_summary.md
 * - `memory://root/<path>`         — relative file under memory root
 * - `memory://search?text=…&scope=…&limit=…&focus=…&hops=…&profile=…` — recall hits (JSON)
 * - `memory://item/<id>`           — single node body (JSON)
 * - `memory://since/<ISO8601>`     — diff payload (stub until W7)
 * - `memory://browse`              — TUI panel hint (W8)
 */
export class MemoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "memory";

	constructor(private readonly options: MemoryProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const namespace = (url.rawHost || url.hostname || "").toLowerCase();
		switch (namespace) {
			case ROOT_NAMESPACE:
				return this.#resolveRoot(url);
			case SEARCH_NAMESPACE:
				return this.#resolveSearch(url);
			case ITEM_NAMESPACE:
				return this.#resolveItem(url);
			case SINCE_NAMESPACE:
				return this.#resolveSince(url);
			case BROWSE_NAMESPACE:
				return this.#resolveBrowse(url);
			default:
				throw new Error(
					`Unknown memory namespace: ${namespace || "(empty)"}. Supported: ${ROOT_NAMESPACE}, ${SEARCH_NAMESPACE}, ${ITEM_NAMESPACE}, ${SINCE_NAMESPACE}, ${BROWSE_NAMESPACE}`,
				);
		}
	}

	#repoRoot(): string {
		if (this.options.getRepoRoot) return path.resolve(this.options.getRepoRoot());
		// Infer from `<project>/.spell/memory` → `<project>`.
		const memoryRoot = path.resolve(this.options.getMemoryRoot());
		return path.dirname(path.dirname(memoryRoot));
	}

	async #resolveRoot(url: InternalUrl): Promise<InternalResource> {
		const memoryRoot = path.resolve(this.options.getMemoryRoot());
		let resolvedRoot: string;
		try {
			resolvedRoot = await fs.realpath(memoryRoot);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(
					"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
				);
			}
			throw error;
		}

		const targetPath = resolveMemoryUrlToPath(url, resolvedRoot);
		ensureWithinRoot(targetPath, resolvedRoot);

		const parentDir = path.dirname(targetPath);
		try {
			const realParent = await fs.realpath(parentDir);
			ensureWithinRoot(realParent, resolvedRoot);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		let realTargetPath: string;
		try {
			realTargetPath = await fs.realpath(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`Memory file not found: ${url.href}`);
			}
			throw error;
		}

		ensureWithinRoot(realTargetPath, resolvedRoot);

		const stat = await fs.stat(realTargetPath);
		if (!stat.isFile()) {
			throw new Error(`memory:// URL must resolve to a file: ${url.href}`);
		}

		const content = await Bun.file(realTargetPath).text();
		const ext = path.extname(realTargetPath).toLowerCase();
		const contentType: InternalResource["contentType"] =
			ext === ".md" ? "text/markdown" : ext === ".org" ? "text/x-org" : "text/plain";

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: realTargetPath,
			notes: [],
		};
	}

	#resolveSearch(url: InternalUrl): InternalResource {
		const sp = url.searchParams;
		const text = sp.get("text") ?? undefined;
		const focus = sp.get("focus") ?? undefined;
		if (!text && !focus) {
			throw new Error("memory://search requires `text` or `focus` query param");
		}
		const result = executeOrg({
			command: "recall",
			text,
			focus,
			scope: parseScopeParam(sp.get("scope")),
			graphHops: parseNumberParam(sp.get("hops")),
			limit: parseNumberParam(sp.get("limit")),
			profile: sp.get("profile") ?? undefined,
			includePersonal: sp.get("includePersonal") === "true" ? true : undefined,
			repoRoot: this.#repoRoot(),
		});
		if (result.error) throw new Error(String(result.output));
		return jsonResource(url, result.output);
	}

	#resolveItem(url: InternalUrl): InternalResource {
		const rawPathname = url.rawPathname ?? url.pathname;
		const id = rawPathname && rawPathname !== "/" ? decodeURIComponent(rawPathname.slice(1)) : "";
		if (!id) throw new Error("memory://item requires an id: memory://item/<id>");
		// subgraph(hops=1) returns the focus node plus its 1-hop neighbours —
		// the closest the native surface offers to a single-node fetch.
		const result = executeOrg({
			command: "subgraph",
			root: id,
			hops: 1,
			repoRoot: this.#repoRoot(),
		});
		if (result.error) throw new Error(String(result.output));
		return jsonResource(url, result.output);
	}

	#resolveSince(url: InternalUrl): InternalResource {
		const rawPathname = url.rawPathname ?? url.pathname;
		const ts = rawPathname && rawPathname !== "/" ? decodeURIComponent(rawPathname.slice(1)) : "";
		if (!ts) throw new Error("memory://since requires a timestamp: memory://since/<ISO8601>");
		const payload = { ts, added: [], modified: [], deleted: [], note: SINCE_STUB_NOTE };
		return jsonResource(url, payload, [SINCE_STUB_NOTE]);
	}

	#resolveBrowse(url: InternalUrl): InternalResource {
		const payload = {
			browse: true,
			hint: "Open TUI panel via /memory slash command",
		};
		return jsonResource(url, payload, ["Open TUI panel via /memory slash command"]);
	}
}
