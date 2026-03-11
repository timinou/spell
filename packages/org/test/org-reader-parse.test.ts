/**
 * Tests for the org file parser (readOrgFile).
 *
 * The parser is a line-state-machine — the contracts are:
 *   - Headings with TODO keywords become OrgItems
 *   - Headings without TODO keywords are skipped
 *   - PROPERTIES drawer properties are extracted
 *   - Body text is collected when includeBody is true
 *   - Nested headings (children) don't bleed into parent body
 *   - Missing file returns empty array (not an error)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readOrgFile } from "../src/org-reader";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-test-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeOrg(name: string, content: string): Promise<string> {
	const p = path.join(tmpDir, name);
	await Bun.write(p, content);
	return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readOrgFile — basic parsing", () => {
	test("parses a single task heading with PROPERTIES", async () => {
		const p = await writeOrg(
			"basic.org",
			`
* ITEM Auth refactor
:PROPERTIES:
:CUSTOM_ID: PROJ-001-auth-refactor
:EFFORT: 3h
:PRIORITY: #A
:END:
`,
		);
		const items = await readOrgFile({ filePath: p, category: "projects", dir: "tasks", todoKeywords: TODO_KEYWORDS });
		expect(items).toHaveLength(1);

		const item = items[0];
		expect(item.id).toBe("PROJ-001-auth-refactor");
		expect(item.title).toBe("Auth refactor");
		expect(item.state).toBe("ITEM");
		expect(item.properties.EFFORT).toBe("3h");
		expect(item.properties.PRIORITY).toBe("#A");
		expect(item.file).toBe(p);
	});

	test("ignores headings without TODO keywords", async () => {
		const p = await writeOrg(
			"structural.org",
			`
* Project Overview
** Background

* ITEM Real task
:PROPERTIES:
:CUSTOM_ID: PROJ-001
:END:
`,
		);
		const items = await readOrgFile({ filePath: p, category: "projects", dir: "tasks", todoKeywords: TODO_KEYWORDS });
		// Only the ITEM heading should appear
		expect(items).toHaveLength(1);
		expect(items[0].id).toBe("PROJ-001");
	});

	test("parses multiple tasks in the same file", async () => {
		const p = await writeOrg(
			"multi.org",
			`
* ITEM First task
:PROPERTIES:
:CUSTOM_ID: BUG-001
:END:

* DOING Second task
:PROPERTIES:
:CUSTOM_ID: BUG-002
:END:

* DONE Third task
:PROPERTIES:
:CUSTOM_ID: BUG-003
:END:
`,
		);
		const items = await readOrgFile({ filePath: p, category: "bugs", dir: "tasks", todoKeywords: TODO_KEYWORDS });
		expect(items).toHaveLength(3);
		expect(items.map(i => i.state)).toEqual(["ITEM", "DOING", "DONE"]);
		expect(items.map(i => i.id)).toEqual(["BUG-001", "BUG-002", "BUG-003"]);
	});

	test("returns empty array for missing file", async () => {
		const items = await readOrgFile({
			filePath: path.join(tmpDir, "nonexistent.org"),
			category: "projects",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
		});
		expect(items).toHaveLength(0);
	});

	test("sets category and dir on items", async () => {
		const p = await writeOrg(
			"cat.org",
			`
* ITEM Task
:PROPERTIES:
:CUSTOM_ID: SPIKE-001
:END:
`,
		);
		const items = await readOrgFile({
			filePath: p,
			category: "spikes",
			dir: "research",
			todoKeywords: TODO_KEYWORDS,
		});
		expect(items[0].category).toBe("spikes");
		expect(items[0].dir).toBe("research");
	});

	test("records line number (1-indexed)", async () => {
		const p = await writeOrg(
			"lines.org",
			`#+TITLE: Test

* ITEM Task on line 3
:PROPERTIES:
:CUSTOM_ID: X-001
:END:
`,
		);
		const items = await readOrgFile({ filePath: p, category: "x", dir: "d", todoKeywords: TODO_KEYWORDS });
		// Line 3 is the heading
		expect(items[0].line).toBe(3);
	});
});

describe("readOrgFile — body extraction", () => {
	test("body is undefined when includeBody is false", async () => {
		const p = await writeOrg(
			"body.org",
			`
* ITEM Task
:PROPERTIES:
:CUSTOM_ID: X-001
:END:

This is the body.
`,
		);
		const items = await readOrgFile({
			filePath: p,
			category: "x",
			dir: "d",
			todoKeywords: TODO_KEYWORDS,
			includeBody: false,
		});
		expect(items[0].body).toBeUndefined();
	});

	test("body is extracted when includeBody is true", async () => {
		const p = await writeOrg(
			"body-yes.org",
			`
* ITEM Task
:PROPERTIES:
:CUSTOM_ID: X-001
:END:

This is the body.
Second line.
`,
		);
		const items = await readOrgFile({
			filePath: p,
			category: "x",
			dir: "d",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});
		expect(items[0].body).toContain("This is the body.");
		expect(items[0].body).toContain("Second line.");
	});

	test("body stops at next heading", async () => {
		const p = await writeOrg(
			"body-stop.org",
			`
* ITEM Task A
:PROPERTIES:
:CUSTOM_ID: X-001
:END:

Body of A.

* ITEM Task B
:PROPERTIES:
:CUSTOM_ID: X-002
:END:

Body of B.
`,
		);
		const items = await readOrgFile({
			filePath: p,
			category: "x",
			dir: "d",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});
		expect(items[0].body).toContain("Body of A.");
		expect(items[0].body).not.toContain("Body of B.");
		expect(items[1].body).toContain("Body of B.");
	});

	test("body excludes trailing blank lines", async () => {
		const p = await writeOrg(
			"trailing.org",
			`
* ITEM Task
:PROPERTIES:
:CUSTOM_ID: X-001
:END:

Content line.


`,
		);
		const items = await readOrgFile({
			filePath: p,
			category: "x",
			dir: "d",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});
		// Body should not end with empty lines
		expect(items[0].body?.endsWith("\n")).toBeFalsy();
		expect(items[0].body?.trim()).toBe("Content line.");
	});
});

describe("readOrgFile — property extraction", () => {
	test("extracts all properties from drawer", async () => {
		const p = await writeOrg(
			"props.org",
			`
* ITEM Task
:PROPERTIES:
:CUSTOM_ID: PROJ-042-example
:EFFORT: 2h
:PRIORITY: #B
:LAYER: backend
:DEPENDS: PROJ-041
:AGENT: task
:END:
`,
		);
		const items = await readOrgFile({ filePath: p, category: "projects", dir: "tasks", todoKeywords: TODO_KEYWORDS });
		const props = items[0].properties;
		expect(props.CUSTOM_ID).toBe("PROJ-042-example");
		expect(props.EFFORT).toBe("2h");
		expect(props.PRIORITY).toBe("#B");
		expect(props.LAYER).toBe("backend");
		expect(props.DEPENDS).toBe("PROJ-041");
		expect(props.AGENT).toBe("task");
	});

	test("CUSTOM_ID is exposed as item.id", async () => {
		const p = await writeOrg(
			"id.org",
			`
* ITEM Task
:PROPERTIES:
:CUSTOM_ID: FEAT-007-dark-mode
:END:
`,
		);
		const items = await readOrgFile({ filePath: p, category: "features", dir: "tasks", todoKeywords: TODO_KEYWORDS });
		expect(items[0].id).toBe("FEAT-007-dark-mode");
	});

	test("id is empty string when CUSTOM_ID missing", async () => {
		const p = await writeOrg(
			"no-id.org",
			`
* ITEM No ID task
:PROPERTIES:
:EFFORT: 1h
:END:
`,
		);
		const items = await readOrgFile({ filePath: p, category: "projects", dir: "tasks", todoKeywords: TODO_KEYWORDS });
		expect(items[0].id).toBe("");
	});
});

describe("readOrgFile — nested headings", () => {
	test("sub-tasks at deeper level are included as separate items", async () => {
		const p = await writeOrg(
			"nested.org",
			`
* ITEM Parent task
:PROPERTIES:
:CUSTOM_ID: PROJ-001
:END:

** DOING Sub-task
:PROPERTIES:
:CUSTOM_ID: PROJ-001-sub
:END:
`,
		);
		const items = await readOrgFile({ filePath: p, category: "projects", dir: "tasks", todoKeywords: TODO_KEYWORDS });
		expect(items).toHaveLength(2);
		expect(items[0].level).toBe(1);
		expect(items[1].level).toBe(2);
	});
});
