/**
 * Tests for applyItemMutations — the unified mutation entry point.
 *
 * Contracts:
 *   - Returns null when CUSTOM_ID not found (both file-level and heading-level)
 *   - Returns string[] of changed fields on success
 *   - Returns [] when item found but no mutation could apply
 *   - Mutations applied in order: state -> title -> body -> append
 *   - When both body and append are set, append applies on top of the new body
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyItemMutations } from "../src/org-writer";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-apply-mutations-"));
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
// Not-found behavior
// ---------------------------------------------------------------------------

describe("applyItemMutations — not found", () => {
	test("returns null when file has no matching CUSTOM_ID", async () => {
		const p = await writeFile(
			"no-match.org",
			`#+TITLE: Some Task
#+STATE: ITEM
#+CUSTOM_ID: TEST-001-some-task

Body here.
`,
		);
		const result = await applyItemMutations(p, "TEST-999-missing", { state: "DONE" }, TODO_KEYWORDS);
		expect(result).toBeNull();

		// File unchanged
		const content = await readFile(p);
		expect(content).toContain("#+STATE: ITEM");
	});

	test("returns null for heading-level item when CUSTOM_ID not in any drawer", async () => {
		const p = await writeFile(
			"no-drawer-match.org",
			`* ITEM Task A
:PROPERTIES:
:CUSTOM_ID: BUG-001
:END:
`,
		);
		const result = await applyItemMutations(p, "BUG-999", { state: "DONE" }, TODO_KEYWORDS);
		expect(result).toBeNull();

		const content = await readFile(p);
		expect(content).toContain("* ITEM Task A");
	});
});

// ---------------------------------------------------------------------------
// Single mutations — heading-level
// ---------------------------------------------------------------------------

describe("applyItemMutations — heading-level single mutations", () => {
	test("state change updates keyword in heading line", async () => {
		const p = await writeFile(
			"state.org",
			`* ITEM Fix the widget
:PROPERTIES:
:CUSTOM_ID: BUG-010
:END:

Some body text.
`,
		);
		const result = await applyItemMutations(p, "BUG-010", { state: "DOING" }, TODO_KEYWORDS);
		expect(result).toEqual(["state"]);

		const content = await readFile(p);
		expect(content).toContain("* DOING Fix the widget");
		expect(content).not.toContain("* ITEM Fix the widget");
	});

	test("state change with note returns both fields, note appears after :END:", async () => {
		const p = await writeFile(
			"state-note.org",
			`* ITEM Review the PR
:PROPERTIES:
:CUSTOM_ID: PR-005
:END:
`,
		);
		const result = await applyItemMutations(p, "PR-005", { state: "REVIEW", note: "Picking this up" }, TODO_KEYWORDS);
		expect(result).toEqual(["state", "note"]);

		const content = await readFile(p);
		expect(content).toContain("* REVIEW Review the PR");
		expect(content).toContain("Picking this up");
		// Note should appear after :END:
		const endIdx = content.indexOf(":END:");
		const noteIdx = content.indexOf("Picking this up");
		expect(noteIdx).toBeGreaterThan(endIdx);
	});

	test("title change updates heading text, preserves stars and keyword", async () => {
		const p = await writeFile(
			"title.org",
			`* DOING Old Title
:PROPERTIES:
:CUSTOM_ID: FEAT-020
:END:

Body.
`,
		);
		const result = await applyItemMutations(p, "FEAT-020", { title: "New Title" }, TODO_KEYWORDS);
		expect(result).toEqual(["title"]);

		const content = await readFile(p);
		expect(content).toContain("* DOING New Title");
		expect(content).not.toContain("Old Title");
	});

	test("body replace replaces content between :END: and next heading", async () => {
		const p = await writeFile(
			"body-replace.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: TSK-001
:END:

Old body content here.
Multiple lines of old body.
`,
		);
		const result = await applyItemMutations(p, "TSK-001", { body: "Brand new body." }, TODO_KEYWORDS);
		expect(result).toEqual(["body"]);

		const content = await readFile(p);
		expect(content).toContain("Brand new body.");
		expect(content).not.toContain("Old body content here.");
		expect(content).not.toContain("Multiple lines of old body.");
	});

	test("body clear (null) removes body content", async () => {
		const p = await writeFile(
			"body-clear.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: TSK-002
:END:

This body should be removed.
`,
		);
		const result = await applyItemMutations(p, "TSK-002", { body: null }, TODO_KEYWORDS);
		expect(result).toEqual(["body"]);

		const content = await readFile(p);
		expect(content).not.toContain("This body should be removed.");
		// Structure preserved
		expect(content).toContain(":CUSTOM_ID: TSK-002");
		expect(content).toContain(":END:");
	});

	test("append to empty body adds text after :END:", async () => {
		const p = await writeFile(
			"append-empty.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: TSK-003
:END:
`,
		);
		const result = await applyItemMutations(p, "TSK-003", { append: "Appended text." }, TODO_KEYWORDS);
		expect(result).toEqual(["append"]);

		const content = await readFile(p);
		expect(content).toContain("Appended text.");
		const endIdx = content.indexOf(":END:");
		const appendIdx = content.indexOf("Appended text.");
		expect(appendIdx).toBeGreaterThan(endIdx);
	});

	test("append to existing body appends with double newline separator", async () => {
		const p = await writeFile(
			"append-existing.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: TSK-004
:END:

Existing body.
`,
		);
		const result = await applyItemMutations(p, "TSK-004", { append: "More content." }, TODO_KEYWORDS);
		expect(result).toEqual(["append"]);

		const content = await readFile(p);
		expect(content).toContain("Existing body.");
		expect(content).toContain("More content.");
		// Double newline separator between existing body and appended text
		expect(content).toContain("Existing body.\n\nMore content.");
	});
});

// ---------------------------------------------------------------------------
// Single mutations — file-level
// ---------------------------------------------------------------------------

describe("applyItemMutations — file-level single mutations", () => {
	test("state change updates #+STATE: line", async () => {
		const p = await writeFile(
			"file-state.org",
			`#+TITLE: File Task
#+STATE: ITEM
#+CUSTOM_ID: FILE-001

Body text.
`,
		);
		const result = await applyItemMutations(p, "FILE-001", { state: "DONE" }, TODO_KEYWORDS);
		expect(result).toEqual(["state"]);

		const content = await readFile(p);
		expect(content).toContain("#+STATE: DONE");
		expect(content).not.toContain("#+STATE: ITEM");
	});

	test("title change updates #+TITLE: line", async () => {
		const p = await writeFile(
			"file-title.org",
			`#+TITLE: Old File Title
#+STATE: ITEM
#+CUSTOM_ID: FILE-002

Body.
`,
		);
		const result = await applyItemMutations(p, "FILE-002", { title: "New File Title" }, TODO_KEYWORDS);
		expect(result).toEqual(["title"]);

		const content = await readFile(p);
		expect(content).toContain("#+TITLE: New File Title");
		expect(content).not.toContain("Old File Title");
	});

	test("body replace replaces content after frontmatter", async () => {
		const p = await writeFile(
			"file-body.org",
			`#+TITLE: Task
#+STATE: ITEM
#+CUSTOM_ID: FILE-003

Old file body.
Should be replaced.
`,
		);
		const result = await applyItemMutations(p, "FILE-003", { body: "New file body." }, TODO_KEYWORDS);
		expect(result).toEqual(["body"]);

		const content = await readFile(p);
		expect(content).toContain("New file body.");
		expect(content).not.toContain("Old file body.");
		expect(content).not.toContain("Should be replaced.");
		// Frontmatter preserved
		expect(content).toContain("#+TITLE: Task");
		expect(content).toContain("#+CUSTOM_ID: FILE-003");
	});

	test("append to existing body in file-level item", async () => {
		const p = await writeFile(
			"file-append.org",
			`#+TITLE: Task
#+STATE: ITEM
#+CUSTOM_ID: FILE-004

Existing file body.
`,
		);
		const result = await applyItemMutations(p, "FILE-004", { append: "Appended file content." }, TODO_KEYWORDS);
		expect(result).toEqual(["append"]);

		const content = await readFile(p);
		expect(content).toContain("Existing file body.");
		expect(content).toContain("Appended file content.");
	});
});

// ---------------------------------------------------------------------------
// Multi-field mutations
// ---------------------------------------------------------------------------

describe("applyItemMutations — multi-field mutations", () => {
	test("state + title + body in one call: all applied, returns all fields", async () => {
		const p = await writeFile(
			"multi-all.org",
			`* ITEM Old Title
:PROPERTIES:
:CUSTOM_ID: MULTI-001
:END:

Old body.
`,
		);
		const result = await applyItemMutations(
			p,
			"MULTI-001",
			{ state: "DONE", title: "New Title", body: "New body content." },
			TODO_KEYWORDS,
		);
		expect(result).toEqual(["state", "title", "body"]);

		const content = await readFile(p);
		expect(content).toContain("* DONE New Title");
		expect(content).not.toContain("Old Title");
		expect(content).toContain("New body content.");
		expect(content).not.toContain("Old body.");
	});

	test("body + append in one call: body replaces first, then append applies on top", async () => {
		const p = await writeFile(
			"body-append.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: MULTI-002
:END:

Original body that will be replaced.
`,
		);
		const result = await applyItemMutations(
			p,
			"MULTI-002",
			{ body: "Replaced body.", append: "Appended on top." },
			TODO_KEYWORDS,
		);
		expect(result).toEqual(["body", "append"]);

		const content = await readFile(p);
		expect(content).not.toContain("Original body");
		expect(content).toContain("Replaced body.");
		expect(content).toContain("Appended on top.");
		// Append comes after the replaced body with separator
		expect(content).toContain("Replaced body.\n\nAppended on top.");
	});

	test("state + append: both applied correctly", async () => {
		const p = await writeFile(
			"state-append.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: MULTI-003
:END:

Existing body.
`,
		);
		const result = await applyItemMutations(
			p,
			"MULTI-003",
			{ state: "DOING", append: "Progress note." },
			TODO_KEYWORDS,
		);
		expect(result).toEqual(["state", "append"]);

		const content = await readFile(p);
		expect(content).toContain("* DOING Task");
		expect(content).toContain("Existing body.");
		expect(content).toContain("Progress note.");
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("applyItemMutations — edge cases", () => {
	test("empty string body clears body same as null", async () => {
		const p = await writeFile(
			"empty-body.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: EDGE-001
:END:

Body to clear.
`,
		);
		const result = await applyItemMutations(p, "EDGE-001", { body: "" }, TODO_KEYWORDS);
		expect(result).toEqual(["body"]);

		const content = await readFile(p);
		expect(content).not.toContain("Body to clear.");
	});

	test("item found but state mutation fails returns empty array, not null", async () => {
		// Heading has no recognized TODO keyword, so state regex won't match
		const p = await writeFile(
			"no-keyword.org",
			`* Random heading without keyword
:PROPERTIES:
:CUSTOM_ID: EDGE-002
:END:

Some body.
`,
		);
		const result = await applyItemMutations(p, "EDGE-002", { state: "DONE" }, TODO_KEYWORDS);
		// Item found (not null) but state change couldn't apply (no keyword to replace)
		expect(result).not.toBeNull();
		expect(result).toEqual([]);

		// File unchanged
		const content = await readFile(p);
		expect(content).toContain("* Random heading without keyword");
	});

	test("multi-item file: only the targeted item is modified", async () => {
		const p = await writeFile(
			"multi-item.org",
			`* ITEM First Task
:PROPERTIES:
:CUSTOM_ID: MULTI-A
:END:

First body.

* ITEM Second Task
:PROPERTIES:
:CUSTOM_ID: MULTI-B
:END:

Second body.

* ITEM Third Task
:PROPERTIES:
:CUSTOM_ID: MULTI-C
:END:

Third body.
`,
		);
		const result = await applyItemMutations(
			p,
			"MULTI-B",
			{ state: "DONE", title: "Updated Second Task", body: "New second body." },
			TODO_KEYWORDS,
		);
		expect(result).toEqual(["state", "title", "body"]);

		const content = await readFile(p);
		// Target item modified
		expect(content).toContain("* DONE Updated Second Task");
		expect(content).toContain("New second body.");
		// Other items preserved
		expect(content).toContain("* ITEM First Task");
		expect(content).toContain("First body.");
		expect(content).toContain("* ITEM Third Task");
		expect(content).toContain("Third body.");
	});

	test("note without state change is ignored (not written)", async () => {
		const p = await writeFile(
			"note-no-state.org",
			`* ITEM Task
:PROPERTIES:
:CUSTOM_ID: EDGE-003
:END:

Body.
`,
		);
		// Only note field set, no state change — note should be ignored
		const result = await applyItemMutations(p, "EDGE-003", { note: "This should not appear" }, TODO_KEYWORDS);
		// Item found but no mutation applied
		expect(result).not.toBeNull();
		expect(result).toEqual([]);

		const content = await readFile(p);
		expect(content).not.toContain("This should not appear");
	});
});
