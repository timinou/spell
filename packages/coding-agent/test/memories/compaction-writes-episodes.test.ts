/**
 * Integration: consolidation pipeline (W6 phase2) writes structured concept
 * entries through `executeOrg(remember, kind=concept, ...)` instead of the
 * legacy MEMORY.md / MEMORY.org blobs. PLAN-310 W7.
 *
 * Uses the real `@oh-my-pi/pi-natives` binding end-to-end so the test exercises
 * the same code path the production consolidation step takes; module-level
 * mocking would leak into sibling tests in the same bun process.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyConsolidation } from "../../src/memories";

let memoryRoot: string;
let repoRoot: string;

beforeEach(async () => {
	memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spell-compact-mem-"));
	repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spell-compact-repo-"));
});

afterEach(async () => {
	await fs.rm(memoryRoot, { recursive: true, force: true });
	await fs.rm(repoRoot, { recursive: true, force: true });
});

async function listConcepts(): Promise<string[]> {
	try {
		return await fs.readdir(path.join(repoRoot, ".spell", "memory", "concepts"));
	} catch {
		return [];
	}
}

async function readConcepts(): Promise<string> {
	const names = await listConcepts();
	const parts: string[] = [];
	for (const n of names) {
		parts.push(await Bun.file(path.join(repoRoot, ".spell", "memory", "concepts", n)).text());
	}
	return parts.join("\n");
}

describe("applyConsolidation (PLAN-310 W7)", () => {
	it("writes a concept file per memory entry via the real native binding", async () => {
		await applyConsolidation(memoryRoot, repoRoot, {
			memoryMd: "ignored",
			memorySummary: "summary text",
			sourceSession: "session-42",
			memoryEntries: [
				{ title: "Structured retries", confidence: 0.7, scope: "tech", body: "Use jitter.", tags: ["network"] },
				{ title: "Caching keys", confidence: 0.8, scope: "tech", body: "Always validate." },
			],
			skills: [],
		});

		const concepts = await listConcepts();
		expect(concepts.length).toBe(2);
		const text = await readConcepts();
		expect(text).toContain("Structured retries");
		expect(text).toContain("Use jitter.");
		expect(text).toContain("Caching keys");
		expect(text).toContain("Always validate.");
		// distilled-from edge propagates into the RELATIONS drawer.
		expect(text).toContain("DISTILLED_FROM: session-42");
	});

	it("no longer writes MEMORY.md / MEMORY.org", async () => {
		await applyConsolidation(memoryRoot, repoRoot, {
			memoryMd: "should not leak",
			memorySummary: "summary",
			sourceSession: "session-1",
			memoryEntries: [{ title: "T", confidence: 0.5, scope: "x", body: "B" }],
			skills: [],
		});

		await expect(fs.access(path.join(memoryRoot, "MEMORY.md"))).rejects.toThrow();
		await expect(fs.access(path.join(memoryRoot, "MEMORY.org"))).rejects.toThrow();
	});

	it("still writes memory_summary.md for the legacy prompt-injection fallback", async () => {
		await applyConsolidation(memoryRoot, repoRoot, {
			memoryMd: "ignored",
			memorySummary: "Use structured retries for flaky network calls.",
			sourceSession: "session-2",
			memoryEntries: [],
			skills: [],
		});
		const text = await Bun.file(path.join(memoryRoot, "memory_summary.md")).text();
		expect(text.trim()).toBe("Use structured retries for flaky network calls.");
	});

	it("handles empty memory_entries gracefully", async () => {
		await applyConsolidation(memoryRoot, repoRoot, {
			memoryMd: "",
			memorySummary: "x",
			sourceSession: "s",
			skills: [],
		});
		const concepts = await listConcepts();
		expect(concepts).toEqual([]);
	});
});
