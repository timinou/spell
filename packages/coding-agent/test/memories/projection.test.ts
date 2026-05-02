import { describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Must mock before importing the module under test.
const mockExecuteOrg = mock();

mock.module("@oh-my-pi/pi-natives", () => ({
	executeOrg: mockExecuteOrg,
}));

const { renderSessionStartSummary } = await import(
	"../../src/memories/projection"
);

async function tmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "spell-proj-"));
}

describe("renderSessionStartSummary", () => {
	it("writes file and returns rendered text", async () => {
		const cwd = await tmpDir();

		mockExecuteOrg.mockImplementation((opts: Record<string, unknown>) => {
			if (opts.command === "recall") {
				return {
					error: false,
					output: {
						hits: [
							{ id: "c1", title: "Rust patterns", score: 0.92, excerpt: "common Rust patterns in codebase" },
							{ id: "c2", title: "API design", score: 0.85, excerpt: "RESTful API conventions" },
						],
					},
				};
			}
			if (opts.command === "query" && opts.kind === "episode") {
				return {
					error: false,
					output: {
						items: [
							{ id: "e1", title: "Refactored auth module" },
						],
					},
				};
			}
			if (opts.command === "query") {
				return {
					error: false,
					output: {
						items: [
							{ id: "w1", title: "Implement dual recall", state: "DOING" },
							{ id: "w2", title: "Add tests", state: "TODO" },
						],
					},
				};
			}
			return { error: true, output: null };
		});

		const result = await renderSessionStartSummary(cwd);

		expect(result).toContain("# Memory Summary");
		expect(result).toContain("Rust patterns");
		expect(result).toContain("API design");
		expect(result).toContain("Refactored auth module");
		expect(result).toContain("DOING Implement dual recall");
		expect(result).toContain("TODO Add tests");

		// Verify file was written
		const filePath = path.join(cwd, ".spell", "memory", "cache", "memory_summary.md");
		const fileContents = await fs.readFile(filePath, "utf8");
		expect(fileContents).toBe(result);

		// Cleanup
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("is idempotent — second call produces identical content", async () => {
		const cwd = await tmpDir();

		mockExecuteOrg.mockImplementation((opts: Record<string, unknown>) => {
			if (opts.command === "recall") {
				return {
					error: false,
					output: {
						hits: [
							{ id: "c1", title: "Rust patterns", score: 0.92, excerpt: "common Rust patterns" },
						],
					},
				};
			}
			if (opts.command === "query" && opts.kind === "episode") {
				return {
					error: false,
					output: { items: [] },
				};
			}
			if (opts.command === "query") {
				return {
					error: false,
					output: {
						items: [
							{ id: "w1", title: "Implement dual recall", state: "DOING" },
						],
					},
				};
			}
			return { error: true, output: null };
		});

		const first = await renderSessionStartSummary(cwd);
		const second = await renderSessionStartSummary(cwd);

		expect(second).toBe(first);

		// Cleanup
		await fs.rm(cwd, { recursive: true, force: true });
	});
});
