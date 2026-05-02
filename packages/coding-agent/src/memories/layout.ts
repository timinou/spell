/**
 * On-disk layout for the org graph memory store.
 *
 * Per-repo memory lives at `<cwd>/.spell/memory/`:
 *  - episodes/<YYYY-MM-DD>.org       daily rollouts (level-1) → episodes (level-2)
 *  - concepts/<slug>.org             one file per distilled concept
 *  - cache/memory_summary.md         deterministic projection (replaces MEMORY.md)
 *  - migrated/<ts>.org               quarantined legacy memory artifacts
 *
 * Personal cross-repo memory lives at `~/.spell/personal/` (FEAT-642).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const GITIGNORE_LINE = "/.spell/memory/";

/**
 * Resolve the per-repo graph-memory root for a given working directory.
 */
export function resolveGraphMemoryRoot(cwd: string): string {
	return path.join(cwd, ".spell", "memory");
}

/**
 * Resolve the personal cross-repo memory root.
 */
export function resolvePersonalMemoryRoot(): string {
	return path.join(os.homedir(), ".spell", "personal");
}

/**
 * Ensure all memory subdirectories exist for the cwd.
 */
export async function ensureGraphMemoryDirs(cwd: string): Promise<void> {
	const root = resolveGraphMemoryRoot(cwd);
	await Promise.all(
		["episodes", "concepts", "cache", "migrated"].map((sub) =>
			fs.mkdir(path.join(root, sub), { recursive: true }),
		),
	);
}

/**
 * Append `/.spell/memory/` to the repo root .gitignore if absent. No-op if
 * the path is not a git checkout.
 */
export async function ensureGitignoreEntry(repoRoot: string): Promise<void> {
	const gitDir = path.join(repoRoot, ".git");
	try {
		const stat = await fs.stat(gitDir);
		if (!stat.isDirectory() && !stat.isFile()) {
			return;
		}
	} catch (err) {
		if (isEnoent(err)) {
			return;
		}
		throw err;
	}

	const giPath = path.join(repoRoot, ".gitignore");
	let existing = "";
	try {
		existing = await fs.readFile(giPath, "utf8");
	} catch (err) {
		if (!isEnoent(err)) {
			throw err;
		}
	}

	const lines = existing.split("\n");
	if (lines.some((l) => l.trim() === GITIGNORE_LINE)) {
		return;
	}

	const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	const next = `${existing}${sep}${GITIGNORE_LINE}\n`;
	await fs.writeFile(giPath, next, "utf8");
}

/**
 * Move legacy `<getMemoriesDir(cwd)>/MEMORY.org` (if any) into
 * `<resolveGraphMemoryRoot(cwd)>/migrated/<isoTs>.org`. Idempotent.
 */
export async function migrateLegacyMemoryFiles(
	cwd: string,
	legacyMemoryDir: string | null,
): Promise<void> {
	if (!legacyMemoryDir) {
		return;
	}
	const legacy = path.join(legacyMemoryDir, "MEMORY.org");
	let exists = false;
	try {
		await fs.stat(legacy);
		exists = true;
	} catch (err) {
		if (!isEnoent(err)) {
			throw err;
		}
	}
	if (!exists) {
		return;
	}

	const root = resolveGraphMemoryRoot(cwd);
	const migratedDir = path.join(root, "migrated");
	await fs.mkdir(migratedDir, { recursive: true });

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const dest = path.join(migratedDir, `${ts}.org`);
	await fs.rename(legacy, dest);

	const readme = path.join(migratedDir, "README.txt");
	try {
		await fs.stat(readme);
	} catch (err) {
		if (isEnoent(err)) {
			await fs.writeFile(
				readme,
				"Files in this directory were moved out of legacy memory paths\nwhen Spell migrated to org-graph-memory v1.\n",
				"utf8",
			);
		} else {
			throw err;
		}
	}
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: string }).code === "ENOENT"
	);
}
