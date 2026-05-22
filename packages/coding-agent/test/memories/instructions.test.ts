import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot } from "../../src/memories";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-instructions-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("buildMemoryToolDeveloperInstructions", () => {
	it("teaches the memory tool and does not expose raw memory root paths", async () => {
		await withTempDir(async agentDir => {
			await withTempDir(async cwd => {
				// Isolated settings pinned to a tmp cwd so renderSessionStartSummary
				// (invoked transitively) does not touch the real spell repo's recall
				// cache or leave stray subprocesses behind.
				const settings = Settings.isolated({ "memories.enabled": true });
				(settings as unknown as { "#cwd": string }).constructor;
				// Force cwd via private field access (test-only escape hatch).
				Object.defineProperty(settings, "getCwd", { value: () => cwd });

				const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
				await fs.mkdir(memoryRoot, { recursive: true });
				await Bun.write(
					path.join(memoryRoot, "memory_summary.md"),
					"Use structured retries for flaky network calls.",
				);

				const instructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);
				expect(instructions).toBeDefined();
				expect(instructions).toContain("memory.search");
				expect(instructions).toContain("memory.note");
				expect(instructions).toContain("memory.save");
				expect(instructions).toContain("memory.since");
				expect(instructions).not.toContain(memoryRoot);
			});
		});
	});
});
