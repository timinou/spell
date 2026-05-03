import * as fs from "node:fs";
import * as path from "node:path";

/** Maximum number of entries per cache before LRU eviction kicks in */
const MAX_CONTENT_CACHE = 500;
const MAX_DIR_CACHE = 500;

const contentCache = new Map<string, string | null>();
const contentInsertionOrder: string[] = [];

const dirCache = new Map<string, fs.Dirent[]>();
const dirInsertionOrder: string[] = [];

function touchContent(key: string): void {
	const idx = contentInsertionOrder.indexOf(key);
	if (idx > -1) contentInsertionOrder.splice(idx, 1);
	contentInsertionOrder.push(key);
	if (contentInsertionOrder.length > MAX_CONTENT_CACHE) {
		const evicted = contentInsertionOrder.shift()!;
		contentCache.delete(evicted);
	}
}

function touchDir(key: string): void {
	const idx = dirInsertionOrder.indexOf(key);
	if (idx > -1) dirInsertionOrder.splice(idx, 1);
	dirInsertionOrder.push(key);
	if (dirInsertionOrder.length > MAX_DIR_CACHE) {
		const evicted = dirInsertionOrder.shift()!;
		dirCache.delete(evicted);
	}
}

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

export async function readFile(filePath: string): Promise<string | null> {
	const abs = resolvePath(filePath);
	if (contentCache.has(abs)) {
		touchContent(abs);
		return contentCache.get(abs) ?? null;
	}

	try {
		const content = await Bun.file(abs).text();
		contentCache.set(abs, content);
		touchContent(abs);
		return content;
	} catch {
		contentCache.set(abs, null);
		touchContent(abs);
		return null;
	}
}

export async function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	if (dirCache.has(abs)) {
		touchDir(abs);
		return dirCache.get(abs) ?? [];
	}

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		dirCache.set(abs, entries);
		touchDir(abs);
		return entries;
	} catch {
		dirCache.set(abs, []);
		touchDir(abs);
		return [];
	}
}

export async function readDir(dirPath: string): Promise<string[]> {
	const entries = await readDirEntries(dirPath);
	return entries.map(entry => entry.name);
}

export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return path.join(current, name);
			if (dir && entry.isDirectory()) return path.join(current, name);
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Walk up from startDir looking for a `.git` entry (file or directory).
 * Returns the directory containing `.git` (the repo root), or null if not in a git repo.
 * Results are based on the cached readDirEntries, so repeated calls are cheap.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = resolvePath(startDir);
	while (true) {
		const entries = await readDirEntries(current);
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

export function clearCache(): void {
	contentCache.clear();
	contentInsertionOrder.length = 0;
	dirCache.clear();
	dirInsertionOrder.length = 0;
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	const cIdx = contentInsertionOrder.indexOf(abs);
	if (cIdx > -1) contentInsertionOrder.splice(cIdx, 1);
	dirCache.delete(abs);
	const dIdx = dirInsertionOrder.indexOf(abs);
	if (dIdx > -1) dirInsertionOrder.splice(dIdx, 1);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
		const pIdx = dirInsertionOrder.indexOf(parent);
		if (pIdx > -1) dirInsertionOrder.splice(pIdx, 1);
	}
}
