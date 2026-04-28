import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { ArtifactCreatedEvent } from "./types";

const DEFAULT_DEBOUNCE_MS = 200;

const MIME_FALLBACK: Record<string, string> = {
	".pdf": "application/pdf",
	".typ": "text/plain",
	".svg": "image/svg+xml",
	".md": "text/markdown",
	".log": "text/plain",
	".jsonl": "application/x-ndjson",
	".txt": "text/plain",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

function mimeFor(filename: string): string {
	const ext = path.extname(filename).toLowerCase();
	return MIME_FALLBACK[ext] ?? "application/octet-stream";
}

function normalizeExt(value: string): string {
	const trimmed = value.trim().toLowerCase();
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/**
 * Match an artifact event against an extension filter list. Filter entries can
 * be specified with or without the leading dot, are case-insensitive, and an
 * `*` entry matches any extension.
 */
export function filterByExt(filter: string[] | undefined, event: ArtifactCreatedEvent): boolean {
	if (!filter || filter.length === 0) return true;
	const normalized = filter.map(normalizeExt);
	if (normalized.includes("*") || normalized.includes(".*")) return true;
	const ext = event.ext.toLowerCase();
	return normalized.includes(ext);
}

interface SessionWatch {
	rootDir: string;
	dirs: Map<string, fs.FSWatcher>;
	debounce: Map<string, NodeJS.Timeout>;
}

type CreatedHandler = (event: ArtifactCreatedEvent) => void;

/**
 * Watch session artifact directories and emit `ArtifactCreatedEvent` for new
 * files written under `<sessionRoot>/<agent>/<tool>/<filename>`. Events are
 * debounced per-uri to coalesce overwrite bursts.
 */
export class ArtifactWatcher {
	#watches = new Map<string, SessionWatch>();
	#handlers = new Set<CreatedHandler>();
	#debounceMs: number;

	constructor(opts: { debounceMs?: number } = {}) {
		this.#debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	}

	onCreated(handler: CreatedHandler): void {
		this.#handlers.add(handler);
	}

	offCreated(handler: CreatedHandler): void {
		this.#handlers.delete(handler);
	}

	watch(sessionId: string, sessionRoot: string): void {
		if (this.#watches.has(sessionId)) return;
		const entry: SessionWatch = { rootDir: sessionRoot, dirs: new Map(), debounce: new Map() };
		this.#watches.set(sessionId, entry);
		this.#mountRoot(sessionId, entry);
	}

	unwatch(sessionId: string): void {
		const entry = this.#watches.get(sessionId);
		if (!entry) return;
		for (const watcher of entry.dirs.values()) watcher.close();
		for (const timer of entry.debounce.values()) clearTimeout(timer);
		this.#watches.delete(sessionId);
	}

	stop(): void {
		for (const sessionId of [...this.#watches.keys()]) {
			this.unwatch(sessionId);
		}
		this.#handlers.clear();
	}

	#mountRoot(sessionId: string, entry: SessionWatch): void {
		try {
			fs.mkdirSync(entry.rootDir, { recursive: true });
		} catch (error) {
			logger.warn("artifact watcher: failed to create root", { sessionId, error: String(error) });
		}
		this.#mountDir(sessionId, entry, entry.rootDir, /* depth */ 0);
		// Pre-mount existing agent/tool dirs so first-write events fire reliably
		// on platforms that don't recurse fs.watch.
		void this.#scanAndMount(sessionId, entry, entry.rootDir, 0);
	}

	async #scanAndMount(sessionId: string, entry: SessionWatch, dir: string, depth: number): Promise<void> {
		if (depth > 2) return;
		try {
			const dirents = await fsp.readdir(dir, { withFileTypes: true });
			for (const item of dirents) {
				if (!item.isDirectory()) continue;
				const sub = path.join(dir, item.name);
				this.#mountDir(sessionId, entry, sub, depth + 1);
				if (depth + 1 < 2) await this.#scanAndMount(sessionId, entry, sub, depth + 1);
			}
		} catch {
			// dir may not exist yet
		}
	}

	#mountDir(sessionId: string, entry: SessionWatch, dir: string, depth: number): void {
		if (entry.dirs.has(dir)) return;
		try {
			const watcher = fs.watch(dir, (_eventType, filename) => {
				if (!filename) return;
				const fullPath = path.join(dir, filename);
				void this.#handleEvent(sessionId, entry, fullPath, depth);
			});
			entry.dirs.set(dir, watcher);
		} catch (error) {
			logger.debug("artifact watcher: mount failed", { dir, error: String(error) });
		}
	}

	async #handleEvent(sessionId: string, entry: SessionWatch, fullPath: string, parentDepth: number): Promise<void> {
		let stat: import("node:fs").Stats;
		try {
			stat = await fsp.stat(fullPath);
		} catch {
			return;
		}
		if (stat.isDirectory()) {
			// Lazily mount nested agent / tool dirs.
			if (parentDepth < 2) this.#mountDir(sessionId, entry, fullPath, parentDepth + 1);
			return;
		}
		// Only files at depth = root + 2 (agent/tool) qualify as artifacts.
		const rel = path.relative(entry.rootDir, fullPath);
		const parts = rel.split(path.sep);
		if (parts.length !== 3) return;
		const [agent, tool, filename] = parts as [string, string, string];
		if (filename.startsWith(".")) return;

		const uri = `artifact://${sessionId}/${agent}/${tool}/${filename}`;
		const existing = entry.debounce.get(uri);
		if (existing) clearTimeout(existing);
		entry.debounce.set(
			uri,
			setTimeout(() => {
				entry.debounce.delete(uri);
				const ext = path.extname(filename).toLowerCase();
				const event: ArtifactCreatedEvent = {
					sessionId,
					uri,
					agent,
					tool,
					filename,
					ext,
					mime: mimeFor(filename),
					sizeBytes: stat.size,
					ts: Date.now(),
				};
				for (const handler of this.#handlers) handler(event);
			}, this.#debounceMs),
		);
	}
}
