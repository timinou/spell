/**
 * Tests for file mutation functions in org-writer.
 *
 * Contracts:
 *   - updateItemStateInFile: finds heading by CUSTOM_ID, swaps keyword, returns true; false when not found
 *   - setPropertyInFile: finds drawer by CUSTOM_ID, upserts property, returns true; false when not found
 *   - appendItemToFile: creates file when absent; appends well-formed heading to existing file
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendItemToFile, setPropertyInFile, updateItemStateInFile } from "../src/org-writer";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-mutate-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(name: string, content: string): Promise<string> {
	const p = path.join(tmpDir, name);
	await Bun.write(p, content);
	return p;
}

async function readFile(p: string): Promise<string> {
	return Bun.file(p).text();
}

// ---------------------------------------------------------------------------
// updateItemStateInFile
// ---------------------------------------------------------------------------

describe("updateItemStateInFile", () => {
	test("updates state of matching item", async () => {
		const p = await writeFile(
			"update.org",
			`* ITEM Fix the thing
:PROPERTIES:
:CUSTOM_ID: BUG-001
:END:
`,
		);
		const result = await updateItemStateInFile(p, "BUG-001", "DOING", TODO_KEYWORDS);
		expect(result).toBe(true);

		const content = await readFile(p);
		expect(content).toContain("* DOING Fix the thing");
		expect(content).not.toContain("* ITEM Fix the thing");
	});

	test("returns false for unknown CUSTOM_ID", async () => {
		const p = await writeFile(
			"notfound.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: BUG-001
:END:
`,
		);
		const result = await updateItemStateInFile(p, "BUG-999", "DONE", TODO_KEYWORDS);
		expect(result).toBe(false);

		// File should be unchanged
		const content = await readFile(p);
		expect(content).toContain("* ITEM Task");
	});

	test("appends note after drawer when provided", async () => {
		const p = await writeFile(
			"note.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: PROJ-001
:END:
`,
		);
		await updateItemStateInFile(p, "PROJ-001", "DOING", TODO_KEYWORDS, "Starting work on this now");

		const content = await readFile(p);
		expect(content).toContain("Starting work on this now");
	});

	test("handles multiple items — only updates the correct one", async () => {
		const p = await writeFile(
			"multi.org",
			`* ITEM Task A
:PROPERTIES:
:CUSTOM_ID: BUG-001
:END:

* ITEM Task B
:PROPERTIES:
:CUSTOM_ID: BUG-002
:END:
`,
		);
		await updateItemStateInFile(p, "BUG-002", "DONE", TODO_KEYWORDS);

		const content = await readFile(p);
		expect(content).toContain("* ITEM Task A");
		expect(content).toContain("* DONE Task B");
	});

	test("preserves heading title after state swap", async () => {
		const p = await writeFile(
			"title.org",
			`* ITEM Implement dark mode feature
:PROPERTIES:
:CUSTOM_ID: FEAT-001
:END:
`,
		);
		await updateItemStateInFile(p, "FEAT-001", "REVIEW", TODO_KEYWORDS);

		const content = await readFile(p);
		expect(content).toContain("* REVIEW Implement dark mode feature");
	});
});

// ---------------------------------------------------------------------------
// setPropertyInFile
// ---------------------------------------------------------------------------

describe("setPropertyInFile", () => {
	test("updates an existing property", async () => {
		const p = await writeFile(
			"prop.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: X-001
:EFFORT: 1h
:END:
`,
		);
		const result = await setPropertyInFile(p, "X-001", "EFFORT", "3h");
		expect(result).toBe(true);

		const content = await readFile(p);
		expect(content).toContain(":EFFORT: 3h");
		// Should not have the old value
		expect(content).not.toContain(":EFFORT: 1h");
	});

	test("adds a new property when not present", async () => {
		const p = await writeFile(
			"newprop.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: X-001
:EFFORT: 2h
:END:
`,
		);
		const result = await setPropertyInFile(p, "X-001", "LAYER", "backend");
		expect(result).toBe(true);

		const content = await readFile(p);
		expect(content).toContain(":LAYER: backend");
		// Existing properties preserved
		expect(content).toContain(":EFFORT: 2h");
	});

	test("returns false for unknown CUSTOM_ID", async () => {
		const p = await writeFile(
			"notfound.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: X-001
:END:
`,
		);
		const result = await setPropertyInFile(p, "X-999", "LAYER", "backend");
		expect(result).toBe(false);

		const content = await readFile(p);
		expect(content).not.toContain(":LAYER:");
	});

	test("handles multiple items — sets on the correct one", async () => {
		const p = await writeFile(
			"multi-prop.org",
			`* ITEM Task A
:PROPERTIES:
:CUSTOM_ID: X-001
:EFFORT: 1h
:END:

* ITEM Task B
:PROPERTIES:
:CUSTOM_ID: X-002
:EFFORT: 2h
:END:
`,
		);
		await setPropertyInFile(p, "X-002", "LAYER", "frontend");

		const content = await readFile(p);
		// X-001 should not have LAYER
		const x001Section = content.split("* ITEM Task B")[0];
		expect(x001Section).not.toContain(":LAYER:");
		// X-002 should have it
		expect(content.split("* ITEM Task B")[1]).toContain(":LAYER: frontend");
	});
});

// ---------------------------------------------------------------------------
// appendItemToFile
// ---------------------------------------------------------------------------

describe("appendItemToFile", () => {
	test("creates new file when it does not exist", async () => {
		const p = path.join(tmpDir, "new.org");
		await appendItemToFile(
			p,
			{
				title: "New task",
				category: "projects",
				id: "PROJ-001-new-task",
			},
			"ITEM",
		);

		const content = await readFile(p);
		expect(content).toContain("#+STATE: ITEM");
		expect(content).toContain("#+TITLE: New task");
		expect(content).toContain("#+CUSTOM_ID: PROJ-001-new-task");
	});

	test("appends to existing file", async () => {
		const p = await writeFile(
			"existing.org",
			`#+TITLE: Test

* ITEM Existing task
:PROPERTIES:
:CUSTOM_ID: PROJ-001
:END:
`,
		);
		await appendItemToFile(
			p,
			{
				title: "New task",
				category: "projects",
				id: "PROJ-002-new-task",
			},
			"ITEM",
		);

		const content = await readFile(p);
		expect(content).toContain(":CUSTOM_ID: PROJ-001");
		expect(content).toContain(":CUSTOM_ID: PROJ-002-new-task");
	});

	test("includes custom properties", async () => {
		const p = path.join(tmpDir, "props.org");
		await appendItemToFile(
			p,
			{
				title: "Task with props",
				category: "features",
				id: "FEAT-001-task-with-props",
				properties: { EFFORT: "4h", PRIORITY: "#A", LAYER: "backend" },
			},
			"DOING",
		);

		const content = await readFile(p);
		expect(content).toContain("#+EFFORT: 4h");
		expect(content).toContain("#+PRIORITY: #A");
		expect(content).toContain("#+LAYER: backend");
		expect(content).toContain("#+STATE: DOING");
	});

	test("includes body text when provided", async () => {
		const p = path.join(tmpDir, "body.org");
		await appendItemToFile(
			p,
			{
				title: "Task with body",
				category: "projects",
				id: "PROJ-001-task-with-body",
				body: "This task does X by doing Y.\n- Step 1\n- Step 2",
			},
			"ITEM",
		);

		const content = await readFile(p);
		expect(content).toContain("This task does X by doing Y.");
		expect(content).toContain("- Step 1");
		expect(content).toContain("- Step 2");
	});

	test("CUSTOM_ID in result matches the provided id", async () => {
		const p = path.join(tmpDir, "idcheck.org");
		const id = "PROJ-042-auth-refactor";
		await appendItemToFile(p, { title: "Auth refactor", category: "projects", id }, "ITEM");

		const content = await readFile(p);
		expect(content).toContain(`#+CUSTOM_ID: ${id}`);
	});
});
