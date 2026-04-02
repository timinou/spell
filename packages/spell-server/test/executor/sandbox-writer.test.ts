import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupStaleSandboxPolicies, removeSandboxPolicy, writeSandboxPolicy } from "../../src/executor";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.all(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
});

async function createTempDir(): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-sandbox-tests-"));
	tempDirs.add(tempDir);
	return tempDir;
}

describe("sandbox writer", () => {
	it("writes deterministic per-goal policy files and removes them", async () => {
		const tempDir = await createTempDir();
		const filePath = await writeSandboxPolicy(
			"Ship It",
			{ pathsWrite: ["src/"], bashAllow: ["git status"], bashDeny: ["rm -rf /"] },
			tempDir,
		);

		expect(path.basename(filePath)).toMatch(new RegExp(`^spell-sandbox-${process.pid}-ship-it-\\d+\\.json$`));
		expect(JSON.parse(await Bun.file(filePath).text())).toEqual({
			pathsWrite: ["src/"],
			bashAllow: ["git status"],
			bashDeny: ["rm -rf /"],
		});

		await removeSandboxPolicy(filePath);
		await expect(fs.access(filePath)).rejects.toThrow();
	});

	it("cleans legacy or dead-process sandbox files without touching live-process files", async () => {
		const tempDir = await createTempDir();
		const legacyFile = path.join(tempDir, "spell-sandbox-legacy.json");
		const deadProcessFile = path.join(tempDir, `spell-sandbox-999999-cleanup-${Date.now()}.json`);
		const liveProcessFile = path.join(tempDir, `spell-sandbox-${process.pid}-keep-${Date.now()}.json`);
		const unrelatedFile = path.join(tempDir, "not-a-sandbox-file.json");
		await Bun.write(legacyFile, "{}");
		await Bun.write(deadProcessFile, "{}");
		await Bun.write(liveProcessFile, "{}");
		await Bun.write(unrelatedFile, "{}");

		const removed = await cleanupStaleSandboxPolicies(tempDir);

		expect(removed.sort()).toEqual([deadProcessFile, legacyFile].sort());
		await expect(fs.access(legacyFile)).rejects.toThrow();
		await expect(fs.access(deadProcessFile)).rejects.toThrow();
		await expect(fs.access(liveProcessFile)).resolves.toBeNull();
		await expect(fs.access(unrelatedFile)).resolves.toBeNull();
	});
});
