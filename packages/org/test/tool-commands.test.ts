/**
 * Tests for createOrgTool execute() dispatch.
 *
 * Contracts:
 *   - create without category defaults to first configured category
 *   - create without any categories configured returns error
 *   - update/note/set with file hint skips scan, operates directly
 *   - update/note/set with file hint falls back to scan when file misses
 *   - includeBody echoes the full item in mutation responses
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool, type OrgToolDefinition } from "../src/tool";
import type { OrgConfig } from "../src/types";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-tool-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function _writeFile(name: string, content: string): Promise<string> {
	const p = path.join(tmpDir, name);
	await fs.mkdir(path.dirname(p), { recursive: true });
	await Bun.write(p, content);
	return p;
}

async function readFile(p: string): Promise<string> {
	return Bun.file(p).text();
}

// Standard config with two categories; "drafts" is first → default.
function makeConfig(): OrgConfig {
	return {
		dirs: {
			tasks: {
				path: "tasks",
				categories: {
					drafts: { prefix: "DRAFT", path: "drafts" },
					projects: { prefix: "PROJ", path: "projects" },
				},
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	};
}

function makeTool(config?: OrgConfig): OrgToolDefinition {
	return createOrgTool(tmpDir, config ?? makeConfig());
}

/** Seed a file-level org item into a category directory. */
async function seedItem(
	category: string,
	id: string,
	title: string,
	opts?: { state?: string; body?: string },
): Promise<string> {
	const state = opts?.state ?? "ITEM";
	const dir = path.join(tmpDir, "tasks", category);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${id}.org`);
	let content = `#+TITLE: ${title}\n#+STATE: ${state}\n#+CUSTOM_ID: ${id}\n`;
	if (opts?.body) {
		content += `\n${opts.body}\n`;
	}
	await Bun.write(filePath, content);
	return filePath;
}

// ---------------------------------------------------------------------------
// Default category for create
// ---------------------------------------------------------------------------

describe("create default category", () => {
	test("uses first configured category when category omitted", async () => {
		const tool = makeTool();
		// Ensure category dirs exist
		await fs.mkdir(path.join(tmpDir, "tasks", "drafts"), { recursive: true });

		const result = (await tool.execute({ command: "create", title: "Test task" })) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.category).toBe("drafts");
		expect(typeof result.id).toBe("string");
		expect((result.id as string).startsWith("DRAFT-")).toBe(true);
		expect(typeof result.file).toBe("string");
	});

	test("returns error when no categories configured", async () => {
		const emptyConfig: OrgConfig = {
			dirs: {
				tasks: {
					path: "tasks",
					categories: {},
				},
			},
			todoKeywords: TODO_KEYWORDS,
			requiredProperties: ["CUSTOM_ID"],
		};
		const tool = makeTool(emptyConfig);

		const result = (await tool.execute({ command: "create", title: "Orphan" })) as Record<string, unknown>;

		expect(result.error).toBe(true);
		expect(typeof result.message).toBe("string");
		expect((result.message as string).toLowerCase()).toContain("no categories");
	});
});

// ---------------------------------------------------------------------------
// File path hint for update
// ---------------------------------------------------------------------------

describe("update with file hint", () => {
	test("operates directly on the hinted file, skipping scan", async () => {
		const filePath = await seedItem("drafts", "DRAFT-001-direct", "Direct hit", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-001-direct",
			state: "DOING",
			file: filePath,
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.file).toBe(filePath);
		expect((result.updated as string[]).includes("state")).toBe(true);

		const content = await readFile(filePath);
		expect(content).toContain("#+STATE: DOING");
	});

	test("falls back to scan when hinted file does not contain the item", async () => {
		// Seed item in projects, but hint to a different file
		const realPath = await seedItem("projects", "PROJ-001-fallback", "Fallback item", { state: "ITEM" });
		const decoyPath = await seedItem("drafts", "DRAFT-999-decoy", "Decoy");
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "PROJ-001-fallback",
			state: "REVIEW",
			file: decoyPath, // wrong file — item isn't here
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.file).toBe(realPath);

		const content = await readFile(realPath);
		expect(content).toContain("#+STATE: REVIEW");
	});

	test("falls back gracefully when hinted file does not exist", async () => {
		const realPath = await seedItem("drafts", "DRAFT-002-exists", "Real item", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-002-exists",
			state: "DONE",
			file: "/tmp/nonexistent-org-file.org",
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.file).toBe(realPath);
	});
});

// ---------------------------------------------------------------------------
// includeBody echo
// ---------------------------------------------------------------------------

describe("includeBody echo", () => {
	test("update with includeBody returns item in response", async () => {
		const filePath = await seedItem("drafts", "DRAFT-010-body", "Body echo", {
			state: "ITEM",
			body: "Some body text",
		});
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-010-body",
			state: "DOING",
			file: filePath,
			includeBody: true,
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.item).toBeDefined();
		const item = result.item as Record<string, unknown>;
		expect(item.id).toBe("DRAFT-010-body");
	});

	test("update without includeBody does not return item field", async () => {
		const filePath = await seedItem("drafts", "DRAFT-011-nobody", "No body echo", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-011-nobody",
			state: "DOING",
			file: filePath,
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.item).toBeUndefined();
	});

	test("note with includeBody returns item in response", async () => {
		const filePath = await seedItem("drafts", "DRAFT-012-note", "Note echo", { state: "DOING" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "note",
			id: "DRAFT-012-note",
			note: "Progress update",
			file: filePath,
			includeBody: true,
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.item).toBeDefined();
	});

	test("set with includeBody returns item in response", async () => {
		const filePath = await seedItem("drafts", "DRAFT-013-set", "Set echo", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "set",
			id: "DRAFT-013-set",
			property: "EFFORT",
			value: "2h",
			file: filePath,
			includeBody: true,
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.item).toBeDefined();
	});

	test("includeBody with bodyless item returns item with undefined body", async () => {
		const filePath = await seedItem("drafts", "DRAFT-014-empty", "No body at all", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-014-empty",
			state: "DOING",
			file: filePath,
			includeBody: true,
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.item).toBeDefined();
		const item = result.item as Record<string, unknown>;
		// body should be undefined or absent — not an error
		expect(item.body === undefined || item.body === "").toBe(true);
	});
});

// ---------------------------------------------------------------------------
// File hint for note and set
// ---------------------------------------------------------------------------

describe("note with file hint", () => {
	test("operates directly on the given file", async () => {
		const filePath = await seedItem("projects", "PROJ-020-noted", "Note target", { state: "DOING" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "note",
			id: "PROJ-020-noted",
			note: "Added a note via file hint",
			file: filePath,
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.file).toBe(filePath);

		const content = await readFile(filePath);
		expect(content).toContain("Added a note via file hint");
	});
});

describe("set with file hint", () => {
	test("operates directly on the given file", async () => {
		const filePath = await seedItem("projects", "PROJ-021-prop", "Set target", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "set",
			id: "PROJ-021-prop",
			property: "LAYER",
			value: "backend",
			file: filePath,
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.file).toBe(filePath);
	});
});
