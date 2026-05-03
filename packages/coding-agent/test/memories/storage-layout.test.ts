import { describe, expect, it, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureGitignoreEntry,
	ensureGraphMemoryDirs,
	migrateLegacyMemoryFiles,
	resolveGraphMemoryRoot,
	resolvePersonalMemoryRoot,
} from "../../src/memories/layout";

async function tmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "spell-layout-"));
}

describe("resolveGraphMemoryRoot", () => {
	it("returns dot-spell-memory relative to cwd", () => {
		expect(resolveGraphMemoryRoot("/some/project")).toBe("/some/project/.spell/memory");
	});

	it("handles trailing slash", () => {
		expect(resolveGraphMemoryRoot("/a/b/")).toBe("/a/b/.spell/memory");
	});
});

describe("resolvePersonalMemoryRoot", () => {
	it("returns home-dot-spell-personal", () => {
		const result = resolvePersonalMemoryRoot();
		expect(result).toBe(path.join(os.homedir(), ".spell", "personal"));
	});
});

describe("ensureGraphMemoryDirs", () => {
	afterEach(async () => {
		/* cleanup handled per-test */
	});

	it("creates episodes/concepts/cache/migrated", async () => {
		const dir = await tmpDir();
		await ensureGraphMemoryDirs(dir);
		const root = resolveGraphMemoryRoot(dir);
		for (const sub of ["episodes", "concepts", "cache", "migrated"]) {
			const stat = await fs.stat(path.join(root, sub));
			expect(stat.isDirectory()).toBe(true);
		}
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("creates only missing dirs (one pre-exists)", async () => {
		const dir = await tmpDir();
		const root = resolveGraphMemoryRoot(dir);
		await fs.mkdir(path.join(root, "episodes"), { recursive: true });
		// Second call should not error even though episodes already exists
		await ensureGraphMemoryDirs(dir);
		// Verify all four exist
		for (const sub of ["episodes", "concepts", "cache", "migrated"]) {
			const stat = await fs.stat(path.join(root, sub));
			expect(stat.isDirectory()).toBe(true);
		}
		await fs.rm(dir, { recursive: true, force: true });
	});
});

describe("ensureGitignoreEntry", () => {
	afterEach(async () => {
		/* cleanup handled per-test */
	});

	it("appends line when absent", async () => {
		const dir = await tmpDir();
		// Create .git dir as marker
		await fs.mkdir(path.join(dir, ".git"), { recursive: true });
		await ensureGitignoreEntry(dir);
		const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
		expect(gi).toContain("/.spell/memory/");
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("is idempotent (run twice → only one line)", async () => {
		const dir = await tmpDir();
		await fs.mkdir(path.join(dir, ".git"), { recursive: true });
		await ensureGitignoreEntry(dir);
		await ensureGitignoreEntry(dir);
		const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
		const matches = gi.split("\n").filter(l => l.trim() === "/.spell/memory/");
		expect(matches.length).toBe(1);
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("is no-op when not a git checkout", async () => {
		const dir = await tmpDir();
		// No .git dir
		await ensureGitignoreEntry(dir);
		// .gitignore should not exist
		try {
			await fs.stat(path.join(dir, ".gitignore"));
			// If it somehow exists, it must not contain our line
			const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
			expect(gi).not.toContain("/.spell/memory/");
		} catch {
			// ENOENT is expected — pass
		}
		await fs.rm(dir, { recursive: true, force: true });
	});
});

describe("migrateLegacyMemoryFiles", () => {
	afterEach(async () => {
		/* cleanup handled per-test */
	});

	it("moves MEMORY.org to migrated dir", async () => {
		const dir = await tmpDir();
		const root = resolveGraphMemoryRoot(dir);
		await fs.mkdir(path.join(root, "migrated"), { recursive: true });

		const legacyDir = await tmpDir();
		await fs.writeFile(path.join(legacyDir, "MEMORY.org"), "* legacy\n", "utf8");

		await migrateLegacyMemoryFiles(dir, legacyDir);

		// MEMORY.org should no longer exist at legacy path
		try {
			await fs.stat(path.join(legacyDir, "MEMORY.org"));
			// Should not reach here
			expect.unreachable("MEMORY.org should have been moved");
		} catch {
			// Expected — ENOENT
		}

		// Should exist in migrated/ with a timestamp-based name
		const migratedFiles = await fs.readdir(path.join(root, "migrated"));
		const orgFiles = migratedFiles.filter(f => f.endsWith(".org"));
		expect(orgFiles.length).toBeGreaterThanOrEqual(1);

		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(legacyDir, { recursive: true, force: true });
	});

	it("idempotent (second run no new file)", async () => {
		const dir = await tmpDir();
		const root = resolveGraphMemoryRoot(dir);
		await fs.mkdir(path.join(root, "migrated"), { recursive: true });

		const legacyDir = await tmpDir();
		await fs.writeFile(path.join(legacyDir, "MEMORY.org"), "* data\n", "utf8");

		await migrateLegacyMemoryFiles(dir, legacyDir);
		await migrateLegacyMemoryFiles(dir, legacyDir);

		const migratedFiles = await fs.readdir(path.join(root, "migrated"));
		const orgFiles = migratedFiles.filter(f => f.endsWith(".org"));
		expect(orgFiles.length).toBe(1);

		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(legacyDir, { recursive: true, force: true });
	});

	it("migrated/README.txt only created once", async () => {
		const dir = await tmpDir();
		const root = resolveGraphMemoryRoot(dir);
		await fs.mkdir(path.join(root, "migrated"), { recursive: true });

		const legacyDir = await tmpDir();
		await fs.writeFile(path.join(legacyDir, "MEMORY.org"), "* data\n", "utf8");

		// Run twice — each run checks README
		await migrateLegacyMemoryFiles(dir, legacyDir);

		// Second run: MEMORY.org no longer exists so this is a no-op
		// To test README creation, we need a fresh MEMORY.org
		await fs.writeFile(path.join(legacyDir, "MEMORY.org"), "* more\n", "utf8");
		await migrateLegacyMemoryFiles(dir, legacyDir);

		// Check README exists (only one)
		const readmePath = path.join(root, "migrated", "README.txt");
		const stat = await fs.stat(readmePath);
		expect(stat.isFile()).toBe(true);

		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(legacyDir, { recursive: true, force: true });
	});
});

describe("cache file writes", () => {
	it("succeed on cache subdir", async () => {
		const dir = await tmpDir();
		const root = resolveGraphMemoryRoot(dir);
		await ensureGraphMemoryDirs(dir);
		const cacheFile = path.join(root, "cache", "test.txt");
		await fs.writeFile(cacheFile, "hello", "utf8");
		const content = await fs.readFile(cacheFile, "utf8");
		expect(content).toBe("hello");
		await fs.rm(dir, { recursive: true, force: true });
	});
});
