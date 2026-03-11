/**
 * Tests for file-level org items.
 *
 * File-level items store metadata as #+KEY: value frontmatter instead of
 * a heading with a :PROPERTIES: drawer. The contracts under test:
 *
 *   Writer:
 *   - serializeFileItem produces #+TITLE, #+STATE, #+CUSTOM_ID, then other props
 *   - appendItemToFile creates new files with file-level format
 *   - appendItemToFile appends heading-level items to existing files
 *
 *   Reader:
 *   - Files with #+CUSTOM_ID are parsed as a level-0 item
 *   - File-level item body = everything after frontmatter
 *   - Heading-level TODO items within the body are parsed as separate items
 *   - Heading-level TODO items are registered as children of the file-level item
 *   - Non-TODO headings in the body are included in body text, not as items
 *   - Files without #+CUSTOM_ID parse only heading-level items (backward compat)
 *
 *   State update:
 *   - updateItemStateInFile changes #+STATE: for file-level items
 *   - updateItemStateInFile changes heading keyword for heading-level items (unchanged)
 *
 *   Property set:
 *   - setPropertyInFile updates existing #+KEY: for file-level items
 *   - setPropertyInFile inserts new #+KEY: for file-level items
 *
 *   Round-trip:
 *   - Writer output → reader produces correct items with body
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readOrgFile } from "../src/org-reader";
import {
	appendItemToFile,
	serializeFileItem,
	serializeHeading,
	setPropertyInFile,
	updateItemStateInFile,
} from "../src/org-writer";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-file-level-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeOrg(name: string, content: string): Promise<string> {
	const p = path.join(tmpDir, name);
	await Bun.write(p, content);
	return p;
}

async function readFile(p: string): Promise<string> {
	return Bun.file(p).text();
}

// =============================================================================
// serializeFileItem
// =============================================================================

describe("serializeFileItem", () => {
	test("produces #+TITLE, #+STATE, then properties", () => {
		const result = serializeFileItem("Auth Refactor", "ITEM", {
			CUSTOM_ID: "DRAFT-001-auth-refactor",
			EFFORT: "6h",
			PRIORITY: "#A",
		});

		const lines = result.split("\n");
		expect(lines[0]).toBe("#+TITLE: Auth Refactor");
		expect(lines[1]).toBe("#+STATE: ITEM");
		expect(result).toContain("#+CUSTOM_ID: DRAFT-001-auth-refactor");
		expect(result).toContain("#+EFFORT: 6h");
		expect(result).toContain("#+PRIORITY: #A");
	});

	test("includes body after blank line separator", () => {
		const result = serializeFileItem(
			"Plan",
			"ITEM",
			{ CUSTOM_ID: "DRAFT-001" },
			"* Problem\n\nSomething is broken.\n\n* Approach\n\n- Fix it",
		);

		expect(result).toContain("#+CUSTOM_ID: DRAFT-001");
		expect(result).toContain("* Problem");
		expect(result).toContain("Something is broken.");
		expect(result).toContain("* Approach");
		expect(result).toContain("- Fix it");

		// Body is separated from frontmatter by a blank line
		const frontmatterEnd = result.indexOf("#+CUSTOM_ID: DRAFT-001") + "#+CUSTOM_ID: DRAFT-001".length;
		const afterFrontmatter = result.slice(frontmatterEnd);
		expect(afterFrontmatter).toMatch(/^\n\n/);
	});

	test("no body produces no extra content", () => {
		const result = serializeFileItem("Empty", "ITEM", { CUSTOM_ID: "X-001" });
		expect(result).not.toContain("* ");
		expect(result.trim()).toMatch(/^#\+/m);
	});

	test("strips special characters from title", () => {
		const result = serializeFileItem("Auth: Refactor & Fix!", "ITEM", { CUSTOM_ID: "X-001" });
		expect(result).toContain("#+TITLE: Auth Refactor  Fix");
	});
});

// =============================================================================
// Reader: file-level items
// =============================================================================

describe("readOrgFile — file-level items", () => {
	test("parses #+CUSTOM_ID file as a level-0 item", async () => {
		const p = await writeOrg(
			"plan.org",
			`#+TITLE: Auth Refactor
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001-auth-refactor
#+PRIORITY: #A
#+LAYER: backend

* Problem

Auth is broken.

* Approach

Fix it.
`,
		);

		const items = await readOrgFile({
			filePath: p,
			category: "drafts",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});

		// File-level item
		expect(items.length).toBeGreaterThanOrEqual(1);
		const fileItem = items[0];
		expect(fileItem.level).toBe(0);
		expect(fileItem.id).toBe("DRAFT-001-auth-refactor");
		expect(fileItem.state).toBe("ITEM");
		expect(fileItem.title).toBe("Auth Refactor");
		expect(fileItem.properties.PRIORITY).toBe("#A");
		expect(fileItem.properties.LAYER).toBe("backend");
	});

	test("file-level body includes all content after frontmatter", async () => {
		const p = await writeOrg(
			"body.org",
			`#+TITLE: Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001

* Problem Statement

Something is wrong.

* Architecture

** Phase 1

Extract modules.

** Phase 2

Clean up.
`,
		);

		const items = await readOrgFile({
			filePath: p,
			category: "drafts",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});

		const body = items[0].body!;
		expect(body).toContain("* Problem Statement");
		expect(body).toContain("Something is wrong.");
		expect(body).toContain("* Architecture");
		expect(body).toContain("** Phase 1");
		expect(body).toContain("Extract modules.");
		expect(body).toContain("** Phase 2");
		expect(body).toContain("Clean up.");
	});

	test("heading-level TODO items within file are parsed as separate items", async () => {
		const p = await writeOrg(
			"mixed.org",
			`#+TITLE: Refactor Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001-refactor

* Architecture

** ITEM Extract timeline module
:PROPERTIES:
:CUSTOM_ID: DRAFT-001-extract-timeline
:EFFORT: 4h
:END:

Move timeline rendering out.

** ITEM Extract profile panel
:PROPERTIES:
:CUSTOM_ID: DRAFT-001-extract-profile
:EFFORT: 2h
:END:

Move profile panel out.
`,
		);

		const items = await readOrgFile({
			filePath: p,
			category: "drafts",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});

		// File-level item + 2 heading-level items
		expect(items).toHaveLength(3);

		expect(items[0].id).toBe("DRAFT-001-refactor");
		expect(items[0].level).toBe(0);

		expect(items[1].id).toBe("DRAFT-001-extract-timeline");
		expect(items[1].level).toBe(2);
		expect(items[1].state).toBe("ITEM");
		expect(items[1].properties.EFFORT).toBe("4h");
		expect(items[1].body).toContain("Move timeline rendering out.");

		expect(items[2].id).toBe("DRAFT-001-extract-profile");
		expect(items[2].level).toBe(2);
		expect(items[2].body).toContain("Move profile panel out.");
	});

	test("non-TODO headings are NOT parsed as items", async () => {
		const p = await writeOrg(
			"freeform.org",
			`#+TITLE: Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001

* Problem

Details here.

* Diagnosis

** Subsection A

More details.

** Subsection B

Even more.
`,
		);

		const items = await readOrgFile({
			filePath: p,
			category: "drafts",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});

		// Only the file-level item — no heading-level items since none have TODO keywords
		expect(items).toHaveLength(1);
		expect(items[0].id).toBe("DRAFT-001");
		expect(items[0].body).toContain("* Problem");
		expect(items[0].body).toContain("** Subsection A");
		expect(items[0].body).toContain("** Subsection B");
	});

	test("file without #+CUSTOM_ID only parses heading-level items", async () => {
		const p = await writeOrg(
			"legacy.org",
			`#+TITLE: Old Format

* ITEM Legacy task
:PROPERTIES:
:CUSTOM_ID: PROJ-001
:END:

Do something.
`,
		);

		const items = await readOrgFile({
			filePath: p,
			category: "projects",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});

		expect(items).toHaveLength(1);
		expect(items[0].id).toBe("PROJ-001");
		expect(items[0].level).toBe(1);
		expect(items[0].body).toContain("Do something.");
	});

	test("body is undefined when includeBody is false for file-level items", async () => {
		const p = await writeOrg(
			"nobody.org",
			`#+TITLE: Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001

Content here.
`,
		);

		const items = await readOrgFile({
			filePath: p,
			category: "drafts",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
			includeBody: false,
		});

		expect(items[0].body).toBeUndefined();
	});
});

// =============================================================================
// updateItemStateInFile — file-level items
// =============================================================================

describe("updateItemStateInFile — file-level items", () => {
	test("updates #+STATE: for file-level item", async () => {
		const p = await writeOrg(
			"state.org",
			`#+TITLE: Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001
#+PRIORITY: #A
`,
		);

		const result = await updateItemStateInFile(p, "DRAFT-001", "DONE", TODO_KEYWORDS);
		expect(result).toBe(true);

		const content = await readFile(p);
		expect(content).toContain("#+STATE: DONE");
		expect(content).not.toContain("#+STATE: ITEM");
		// Other properties preserved
		expect(content).toContain("#+PRIORITY: #A");
	});

	test("appends note after frontmatter when provided", async () => {
		const p = await writeOrg(
			"note.org",
			`#+TITLE: Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001

Body content.
`,
		);

		const result = await updateItemStateInFile(p, "DRAFT-001", "DONE", TODO_KEYWORDS, "Plan approved");
		expect(result).toBe(true);

		const content = await readFile(p);
		expect(content).toContain("#+STATE: DONE");
		expect(content).toContain("NOTE");
		expect(content).toContain("Plan approved");
		// Body content preserved
		expect(content).toContain("Body content.");
	});

	test("returns false when CUSTOM_ID not found", async () => {
		const p = await writeOrg(
			"miss.org",
			`#+TITLE: Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001
`,
		);

		const result = await updateItemStateInFile(p, "DRAFT-999", "DONE", TODO_KEYWORDS);
		expect(result).toBe(false);
	});

	test("still works for heading-level items in mixed file", async () => {
		const p = await writeOrg(
			"mixed-state.org",
			`#+TITLE: Plan
#+STATE: DOING
#+CUSTOM_ID: DRAFT-001

* Architecture

** ITEM Extract module
:PROPERTIES:
:CUSTOM_ID: DRAFT-001-extract
:END:

Do it.
`,
		);

		// Update the heading-level item
		const result = await updateItemStateInFile(p, "DRAFT-001-extract", "DONE", TODO_KEYWORDS);
		expect(result).toBe(true);

		const content = await readFile(p);
		expect(content).toContain("** DONE Extract module");
		// File-level state unchanged
		expect(content).toContain("#+STATE: DOING");
	});
});

// =============================================================================
// setPropertyInFile — file-level items
// =============================================================================

describe("setPropertyInFile — file-level items", () => {
	test("updates existing #+KEY: property", async () => {
		const p = await writeOrg(
			"setprop.org",
			`#+TITLE: Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001
#+PRIORITY: #B
`,
		);

		const result = await setPropertyInFile(p, "DRAFT-001", "PRIORITY", "#A");
		expect(result).toBe(true);

		const content = await readFile(p);
		expect(content).toContain("#+PRIORITY: #A");
		expect(content).not.toContain("#+PRIORITY: #B");
	});

	test("inserts new #+KEY: property after frontmatter", async () => {
		const p = await writeOrg(
			"newprop.org",
			`#+TITLE: Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001
`,
		);

		const result = await setPropertyInFile(p, "DRAFT-001", "LAYER", "backend");
		expect(result).toBe(true);

		const content = await readFile(p);
		expect(content).toContain("#+LAYER: backend");
	});

	test("returns false when CUSTOM_ID not found", async () => {
		const p = await writeOrg(
			"noid.org",
			`#+TITLE: Plan
#+STATE: ITEM
#+CUSTOM_ID: DRAFT-001
`,
		);

		const result = await setPropertyInFile(p, "DRAFT-999", "PRIORITY", "#A");
		expect(result).toBe(false);
	});
});

// =============================================================================
// Round-trip: writer → reader
// =============================================================================

describe("round-trip: appendItemToFile → readOrgFile", () => {
	test("new file round-trips correctly", async () => {
		const p = path.join(tmpDir, "roundtrip.org");
		await appendItemToFile(
			p,
			{
				title: "Auth Refactor",
				category: "drafts",
				id: "DRAFT-001-auth-refactor",
				properties: { EFFORT: "6h", PRIORITY: "#A", LAYER: "backend" },
				body: "* Problem\n\nAuth is broken.\n\n* Approach\n\n- Fix it",
			},
			"ITEM",
		);

		const items = await readOrgFile({
			filePath: p,
			category: "drafts",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});

		expect(items).toHaveLength(1);
		const item = items[0];
		expect(item.id).toBe("DRAFT-001-auth-refactor");
		expect(item.state).toBe("ITEM");
		expect(item.title).toBe("Auth Refactor");
		expect(item.level).toBe(0);
		expect(item.properties.EFFORT).toBe("6h");
		expect(item.properties.PRIORITY).toBe("#A");
		expect(item.properties.LAYER).toBe("backend");
		expect(item.body).toContain("* Problem");
		expect(item.body).toContain("Auth is broken.");
		expect(item.body).toContain("* Approach");
		expect(item.body).toContain("- Fix it");
	});

	test("appended heading-level item round-trips within existing file", async () => {
		const p = path.join(tmpDir, "append-roundtrip.org");

		// Create file-level item
		await appendItemToFile(
			p,
			{
				title: "Plan",
				category: "drafts",
				id: "DRAFT-001",
				body: "* Overview\n\nSome context.",
			},
			"ITEM",
		);

		// Append a heading-level sub-task
		await appendItemToFile(
			p,
			{
				title: "Sub task",
				category: "drafts",
				id: "DRAFT-001-sub",
				properties: { EFFORT: "2h" },
			},
			"ITEM",
		);

		const items = await readOrgFile({
			filePath: p,
			category: "drafts",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});

		// File-level item + heading-level item
		expect(items).toHaveLength(2);
		expect(items[0].id).toBe("DRAFT-001");
		expect(items[0].level).toBe(0);
		expect(items[1].id).toBe("DRAFT-001-sub");
		expect(items[1].level).toBe(1);
		expect(items[1].properties.EFFORT).toBe("2h");
	});

	test("state update round-trips: write → update → read", async () => {
		const p = path.join(tmpDir, "state-roundtrip.org");
		await appendItemToFile(
			p,
			{
				title: "Plan",
				category: "drafts",
				id: "DRAFT-001",
				body: "* Content\n\nHere.",
			},
			"ITEM",
		);

		await updateItemStateInFile(p, "DRAFT-001", "DONE", TODO_KEYWORDS);

		const items = await readOrgFile({
			filePath: p,
			category: "drafts",
			dir: "tasks",
			todoKeywords: TODO_KEYWORDS,
			includeBody: true,
		});

		expect(items[0].state).toBe("DONE");
		expect(items[0].body).toContain("* Content");
	});
});
