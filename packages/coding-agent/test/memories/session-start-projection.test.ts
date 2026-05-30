/**
 * Integration: renderSessionStartSummary writes a deterministic
 * memory_summary.md projection at `<cwd>/.spell/memory/cache/`. PLAN-310 W7.
 *
 * Uses the real `@spell/pi-natives` binding against an empty memory store
 * so the projection runs end-to-end without leaking module mocks into sibling
 * tests in the same bun process.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderSessionStartSummary } from "../../src/memories/projection";

let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "spell-projection-"));
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("renderSessionStartSummary", () => {
	it("writes memory_summary.md under <cwd>/.spell/memory/cache/", async () => {
		const rendered = await renderSessionStartSummary(cwd);
		const filePath = path.join(cwd, ".spell", "memory", "cache", "memory_summary.md");
		const onDisk = await Bun.file(filePath).text();
		expect(onDisk).toBe(rendered);
		expect(rendered).toContain("# Memory Summary");
	});

	it("is deterministic — second run produces byte-identical content", async () => {
		const first = await renderSessionStartSummary(cwd);
		const filePath = path.join(cwd, ".spell", "memory", "cache", "memory_summary.md");
		const bytesFirst = await fs.readFile(filePath);

		await fs.rm(filePath);
		const second = await renderSessionStartSummary(cwd);
		const bytesSecond = await fs.readFile(filePath);

		expect(second).toBe(first);
		expect(bytesSecond.equals(bytesFirst)).toBe(true);
	});

	it("renders an empty-state summary when the memory store is empty", async () => {
		const rendered = await renderSessionStartSummary(cwd);
		// No transient timestamp leak in the rendered output.
		expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
		expect(rendered).toContain("# Memory Summary");
	});
});
