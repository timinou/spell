/**
 * Tests for scanMaxSequence and generateId.
 *
 * scanMaxSequence is the foundation of ID uniqueness — it determines the next
 * sequence number by inspecting existing :CUSTOM_ID: values in .org files.
 * A bug here causes ID collisions across sessions.
 *
 * Contracts:
 *   - Returns 0 when the directory is empty or missing
 *   - Returns the highest existing sequence number for the given prefix
 *   - Is prefix-scoped: PROJ-050 does not affect BUG counters
 *   - Scans all .org files in the directory (not just one)
 *   - generateId returns {PREFIX}-{NNN}-{slug} where NNN = max + 1
 *   - generateId pads the number to at least 3 digits
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateId, scanMaxSequence } from "../src/id-generator";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-scan-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeOrgWithIds(name: string, ids: string[]): Promise<void> {
	const lines = ids.flatMap(id => ["* ITEM Task", ":PROPERTIES:", `:CUSTOM_ID: ${id}`, ":END:", ""]);
	await Bun.write(path.join(tmpDir, name), lines.join("\n"));
}

// ---------------------------------------------------------------------------
// scanMaxSequence
// ---------------------------------------------------------------------------

describe("scanMaxSequence", () => {
	test("returns 0 for a missing directory", async () => {
		const result = await scanMaxSequence(path.join(tmpDir, "nonexistent"), "PROJ");
		expect(result).toBe(0);
	});

	test("returns 0 for an empty directory", async () => {
		const result = await scanMaxSequence(tmpDir, "PROJ");
		expect(result).toBe(0);
	});

	test("returns 0 when no matching prefix IDs exist", async () => {
		await writeOrgWithIds("a.org", ["BUG-001", "BUG-002"]);
		const result = await scanMaxSequence(tmpDir, "PROJ");
		expect(result).toBe(0);
	});

	test("finds the maximum sequence number", async () => {
		await writeOrgWithIds("a.org", ["PROJ-001-foo", "PROJ-005-bar"]);
		const result = await scanMaxSequence(tmpDir, "PROJ");
		expect(result).toBe(5);
	});

	test("scans across multiple files", async () => {
		await writeOrgWithIds("a.org", ["PROJ-003"]);
		await writeOrgWithIds("b.org", ["PROJ-007-high"]);
		await writeOrgWithIds("c.org", ["PROJ-002-low"]);
		const result = await scanMaxSequence(tmpDir, "PROJ");
		expect(result).toBe(7);
	});

	test("is scoped to prefix — PROJ IDs do not affect BUG count", async () => {
		await writeOrgWithIds("mixed.org", ["PROJ-050-large", "BUG-002"]);
		const bugMax = await scanMaxSequence(tmpDir, "BUG");
		expect(bugMax).toBe(2);

		const projMax = await scanMaxSequence(tmpDir, "PROJ");
		expect(projMax).toBe(50);
	});

	test("IDs with slugs are counted correctly", async () => {
		await writeOrgWithIds("slugged.org", ["FEAT-012-implement-dark-mode"]);
		const result = await scanMaxSequence(tmpDir, "FEAT");
		expect(result).toBe(12);
	});
});

// ---------------------------------------------------------------------------
// generateId
// ---------------------------------------------------------------------------

describe("generateId", () => {
	test("generates next ID from max + 1", async () => {
		await writeOrgWithIds("existing.org", ["PROJ-004"]);
		const id = await generateId(tmpDir, "PROJ", "New task");
		expect(id).toMatch(/^PROJ-005-/);
	});

	test("starts at 001 when directory is empty", async () => {
		const id = await generateId(tmpDir, "BUG", "First bug");
		expect(id).toMatch(/^BUG-001-/);
	});

	test("pads sequence number to at least 3 digits", async () => {
		const id = await generateId(tmpDir, "SPIKE", "Short");
		expect(id).toMatch(/^SPIKE-\d{3}-/);
	});

	test("appends kebab slug from title", async () => {
		const id = await generateId(tmpDir, "PROJ", "Implement Auth Refactor");
		expect(id).toContain("implement-auth-refactor");
	});

	test("returns PREFIX-NNN without slug when title is all special chars", async () => {
		const id = await generateId(tmpDir, "PROJ", "!@#$%");
		expect(id).toMatch(/^PROJ-\d{3}$/);
	});

	test("two consecutive calls increment correctly", async () => {
		const id1 = await generateId(tmpDir, "PROJ", "Task one");
		// Simulate writing id1 so the second call sees it
		await writeOrgWithIds("task1.org", [id1]);

		const id2 = await generateId(tmpDir, "PROJ", "Task two");
		const num1 = Number.parseInt(id1.split("-")[1], 10);
		const num2 = Number.parseInt(id2.split("-")[1], 10);
		expect(num2).toBe(num1 + 1);
	});
});
