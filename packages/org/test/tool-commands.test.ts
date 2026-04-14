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

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

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
	opts?: { state?: string; body?: string; properties?: Record<string, string> },
): Promise<string> {
	const state = opts?.state ?? "ITEM";
	const dir = path.join(tmpDir, "tasks", category);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${id}.org`);
	let content = `#+TITLE: ${title}\n#+STATE: ${state}\n#+CUSTOM_ID: ${id}\n`;
	if (opts?.properties) {
		for (const [key, value] of Object.entries(opts.properties)) {
			content += `#+${key}: ${value}\n`;
		}
	}
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

describe("update section routing", () => {
	test("section without body/append returns validation error", async () => {
		const filePath = await seedItem("drafts", "DRAFT-003-section-missing", "Section missing", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-003-section-missing",
			file: filePath,
			section: "Implementation",
		})) as Record<string, unknown>;

		expect(result.error).toBe(true);
		expect(result.message).toBe("update with section requires exactly one of: body, append");
	});

	test("section with both body and append returns validation error", async () => {
		const filePath = await seedItem("drafts", "DRAFT-004-section-both", "Section both", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-004-section-both",
			file: filePath,
			section: "Implementation",
			body: "Replaced",
			append: "Appended",
		})) as Record<string, unknown>;

		expect(result.error).toBe(true);
		expect(result.message).toBe("update with section requires exactly one of: body, append");
	});

	test("section cannot combine state, title, or note", async () => {
		const filePath = await seedItem("drafts", "DRAFT-004-section-mixed", "Section mixed", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-004-section-mixed",
			file: filePath,
			section: "Implementation",
			body: "Replaced",
			state: "DOING",
		})) as Record<string, unknown>;

		expect(result.error).toBe(true);
		expect(result.message).toBe("update with section cannot combine state, title, or note");
	});

	test("section with body uses native engine", async () => {
		const filePath = await seedItem("drafts", "DRAFT-005-section-route", "Section route", {
			state: "ITEM",
			body: "** Implementation\nOld section body\n",
		});
		const tool = makeTool();
		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-005-section-route",
			file: filePath,
			section: "Implementation",
			body: "New section body",
		})) as Record<string, unknown>;
		expect(result.success).toBe(true);
	});

	test("non-section body update remains on TS mutation path", async () => {
		const filePath = await seedItem("drafts", "DRAFT-006-no-section", "No section", {
			state: "ITEM",
			body: "Old body",
		});
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-006-no-section",
			file: filePath,
			body: "Replaced body",
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.file).toBe(filePath);
		expect((result.updated as string[]).includes("body")).toBe(true);

		const content = await readFile(filePath);
		expect(content).toContain("Replaced body");
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

// ---------------------------------------------------------------------------
// Query: sort, limit, offset
// ---------------------------------------------------------------------------

describe("query sort and pagination", () => {
	test("query returns items sorted by priority by default", async () => {
		await seedItem("drafts", "DRAFT-100-low", "Low priority", { state: "ITEM" });
		await seedItem("drafts", "DRAFT-101-high", "High priority", { state: "ITEM" });
		// Manually set priorities via frontmatter
		const lowPath = path.join(tmpDir, "tasks", "drafts", "DRAFT-100-low.org");
		const highPath = path.join(tmpDir, "tasks", "drafts", "DRAFT-101-high.org");
		await Bun.write(lowPath, `#+TITLE: Low priority\n#+STATE: ITEM\n#+CUSTOM_ID: DRAFT-100-low\n#+PRIORITY: #C\n`);
		await Bun.write(highPath, `#+TITLE: High priority\n#+STATE: ITEM\n#+CUSTOM_ID: DRAFT-101-high\n#+PRIORITY: #A\n`);

		const tool = makeTool();
		const result = (await tool.execute({ command: "query", category: "drafts" })) as {
			items: Array<{ id: string }>;
			total: number;
		};

		expect(result.items.length).toBeGreaterThanOrEqual(2);
		const ids = result.items.map(i => i.id);
		const highIdx = ids.indexOf("DRAFT-101-high");
		const lowIdx = ids.indexOf("DRAFT-100-low");
		expect(highIdx).toBeLessThan(lowIdx);
	});

	test("query uses descending ids as the default tie-breaker", async () => {
		await seedItem("projects", "PROJ-100-old", "Old item", { state: "ITEM", properties: { PRIORITY: "#B" } });
		await seedItem("projects", "PROJ-101-new", "New item", { state: "ITEM", properties: { PRIORITY: "#B" } });
		const tool = makeTool();
		const result = (await tool.execute({ command: "query", category: "projects" })) as {
			items: Array<{ id: string }>;
			total: number;
		};

		expect(result.items[0]?.id).toBe("PROJ-101-new");
		expect(result.items[1]?.id).toBe("PROJ-100-old");
	});

	test("query sorts ids descending when sort=id", async () => {
		await seedItem("projects", "PROJ-200-old", "Old item", { state: "ITEM" });
		await seedItem("projects", "PROJ-201-new", "New item", { state: "ITEM" });
		const tool = makeTool();
		const result = (await tool.execute({ command: "query", category: "projects", sort: "id" })) as {
			items: Array<{ id: string }>;
			total: number;
		};

		expect(result.items[0]?.id).toBe("PROJ-201-new");
		expect(result.items[1]?.id).toBe("PROJ-200-old");
	});

	test("query with limit returns at most N items", async () => {
		for (let i = 0; i < 5; i++) {
			await seedItem("drafts", `DRAFT-20${i}-lim`, `Limit test ${i}`, { state: "ITEM" });
		}
		const tool = makeTool();
		const result = (await tool.execute({ command: "query", category: "drafts", limit: 3 })) as {
			items: unknown[];
			total: number;
		};

		expect(result.items.length).toBe(3);
		expect(result.total).toBeGreaterThanOrEqual(5);
	});

	test("query with offset skips items", async () => {
		for (let i = 0; i < 5; i++) {
			await seedItem("projects", `PROJ-30${i}-off`, `Offset test ${i}`, { state: "ITEM" });
		}
		const tool = makeTool();

		const all = (await tool.execute({ command: "query", category: "projects" })) as {
			items: Array<{ id: string }>;
			total: number;
		};
		const paginated = (await tool.execute({ command: "query", category: "projects", offset: 2, limit: 2 })) as {
			items: Array<{ id: string }>;
			total: number;
		};

		expect(paginated.items.length).toBe(2);
		expect(paginated.total).toBe(all.total);
		// Items should be offset by 2 from the full sorted list
		expect(paginated.items[0].id).toBe(all.items[2].id);
		expect(paginated.items[1].id).toBe(all.items[3].id);
	});
});

describe("priority queries", () => {
	test("priority:>=B returns items with priority A and B", async () => {
		await seedItem("drafts", "DRAFT-PRI-A", "Priority A", { state: "ITEM", properties: { PRIORITY: "#A" } });
		await seedItem("drafts", "DRAFT-PRI-B", "Priority B", { state: "ITEM", properties: { PRIORITY: "#B" } });
		await seedItem("drafts", "DRAFT-PRI-C", "Priority C", { state: "ITEM", properties: { PRIORITY: "#C" } });
		const tool = makeTool();
		const result = (await tool.execute({ command: "query", query: "priority:>=B" })) as {
			items: unknown[];
			total: number;
		};
		expect(result.total).toBe(2);
	});

	test("priority:A matches only #A items", async () => {
		await seedItem("drafts", "DRAFT-PRI-ONLY-A", "Only A", { state: "ITEM", properties: { PRIORITY: "#A" } });
		await seedItem("drafts", "DRAFT-PRI-ONLY-B", "Only B", { state: "ITEM", properties: { PRIORITY: "#B" } });
		const tool = makeTool();
		const result = (await tool.execute({ command: "query", query: "priority:A" })) as {
			items: unknown[];
			total: number;
		};
		expect(result.total).toBe(1);
	});

	test("priority:<=B returns items with priority B and C", async () => {
		await seedItem("drafts", "DRAFT-PRI-LTE-A", "LTE A", { state: "ITEM", properties: { PRIORITY: "#A" } });
		await seedItem("drafts", "DRAFT-PRI-LTE-B", "LTE B", { state: "ITEM", properties: { PRIORITY: "#B" } });
		await seedItem("drafts", "DRAFT-PRI-LTE-C", "LTE C", { state: "ITEM", properties: { PRIORITY: "#C" } });
		const tool = makeTool();
		const result = (await tool.execute({ command: "query", query: "priority:<=B" })) as {
			items: unknown[];
			total: number;
		};
		expect(result.total).toBe(2);
	});

	test("priority:#B matches #B items (with hash prefix)", async () => {
		await seedItem("drafts", "DRAFT-PRI-HASH-A", "Hash A", { state: "ITEM", properties: { PRIORITY: "#A" } });
		await seedItem("drafts", "DRAFT-PRI-HASH-B", "Hash B", { state: "ITEM", properties: { PRIORITY: "#B" } });
		const tool = makeTool();
		const result = (await tool.execute({ command: "query", query: "priority:#B" })) as {
			items: unknown[];
			total: number;
		};
		expect(result.total).toBe(1);
	});
});

describe("validate-plan command", () => {
	test("delegates to injected validator result", async () => {
		const issues = [{ category: "thin-child-body", items: ["FEAT-101-thin"], message: "Body too small" }];
		const tool = createOrgTool(tmpDir, makeConfig(), {
			validatePlan: async (id: string) => ({ valid: false, id, issues }),
		});

		const result = (await tool.execute({ command: "validate-plan", id: "PLAN-101-test" })) as Record<string, unknown>;

		expect(result).toEqual({ valid: false, id: "PLAN-101-test", issues });
	});

	test("returns an error when no validator is configured", async () => {
		const tool = makeTool();
		const result = (await tool.execute({ command: "validate-plan", id: "PLAN-404" })) as Record<string, unknown>;

		expect(result.error).toBe(true);
		expect(result.message).toBe("validate-plan is not available in this org tool context");
	});
});

describe("delete command", () => {
	test("deletes an ITEM-state item", async () => {
		const filePath = await seedItem("drafts", "DRAFT-030-delete-item", "Delete me", { state: "ITEM" });
		const tool = makeTool();

		const result = (await tool.execute({ command: "delete", id: "DRAFT-030-delete-item" })) as Record<
			string,
			unknown
		>;

		expect(result).toEqual({ success: true, id: "DRAFT-030-delete-item", file: filePath, deleted: true });
		await expect(fs.stat(filePath)).rejects.toBeDefined();
	});

	test("deletes a DONE-state item", async () => {
		const filePath = await seedItem("drafts", "DRAFT-031-delete-done", "Delete done", { state: "DONE" });
		const tool = makeTool();

		const result = (await tool.execute({ command: "delete", id: "DRAFT-031-delete-done" })) as Record<
			string,
			unknown
		>;

		expect(result.success).toBe(true);
		expect(result.file).toBe(filePath);
		await expect(fs.stat(filePath)).rejects.toBeDefined();
	});

	test("deletes a CANCELLED-state item", async () => {
		const filePath = await seedItem("drafts", "DRAFT-032-delete-cancelled", "Delete cancelled", {
			state: "CANCELLED",
		});
		const tool = makeTool();

		const result = (await tool.execute({ command: "delete", id: "DRAFT-032-delete-cancelled" })) as Record<
			string,
			unknown
		>;

		expect(result.success).toBe(true);
		expect(result.file).toBe(filePath);
		await expect(fs.stat(filePath)).rejects.toBeDefined();
	});

	test("refuses to delete a DOING-state item", async () => {
		const filePath = await seedItem("drafts", "DRAFT-033-delete-doing", "Delete doing", { state: "DOING" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "delete",
			id: "DRAFT-033-delete-doing",
			file: filePath,
		})) as Record<string, unknown>;

		expect(result.error).toBe(true);
		expect(result.message).toBe("Cannot delete active item DRAFT-033-delete-doing while it is DOING");
		const content = await readFile(filePath);
		expect(content).toContain("#+STATE: DOING");
	});

	test("refuses to delete a REVIEW-state item", async () => {
		const filePath = await seedItem("drafts", "DRAFT-034-delete-review", "Delete review", { state: "REVIEW" });
		const tool = makeTool();

		const result = (await tool.execute({
			command: "delete",
			id: "DRAFT-034-delete-review",
			file: filePath,
		})) as Record<string, unknown>;

		expect(result.error).toBe(true);
		expect(result.message).toBe("Cannot delete active item DRAFT-034-delete-review while it is REVIEW");
	});

	test("returns NOT_FOUND when deleting a missing item", async () => {
		const tool = makeTool();
		const result = (await tool.execute({ command: "delete", id: "DRAFT-404-missing" })) as Record<string, unknown>;

		expect(result.error).toBe(true);
		expect(result.code).toBe("NOT_FOUND");
	});

	test("deleted items are no longer returned by get", async () => {
		await seedItem("projects", "PROJ-035-delete-get", "Delete then get", { state: "ITEM" });
		const tool = makeTool();

		await tool.execute({ command: "delete", id: "PROJ-035-delete-get" });
		const result = (await tool.execute({ command: "get", id: "PROJ-035-delete-get" })) as Record<string, unknown>;

		expect(result.error).toBe(true);
		expect(result.code).toBe("NOT_FOUND");
	});
});

describe("mutation body responses", () => {
	test("create with body returns body and bodyLength", async () => {
		const tool = makeTool();
		const result = (await tool.execute({
			command: "create",
			title: "Body response",
			category: "drafts",
			body: "* Scope\nDetailed body text",
		})) as Record<string, unknown>;

		expect(result.body).toBe("* Scope\nDetailed body text");
		expect(result.bodyLength).toBe("* Scope\nDetailed body text".length);
	});

	test("create without body omits body fields", async () => {
		const tool = makeTool();
		const result = (await tool.execute({
			command: "create",
			title: "No body response",
			category: "drafts",
		})) as Record<string, unknown>;

		expect(result.body).toBeUndefined();
		expect(result.bodyLength).toBeUndefined();
	});

	test("update with body returns final body and bodyLength", async () => {
		const filePath = await seedItem("drafts", "DRAFT-040-update-body-response", "Body replace", {
			state: "ITEM",
			body: "Old body",
		});
		const tool = makeTool();
		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-040-update-body-response",
			file: filePath,
			body: "* Scope\nReplaced body",
		})) as Record<string, unknown>;

		expect(result.body).toBe("* Scope\nReplaced body");
		expect(result.bodyLength).toBe("* Scope\nReplaced body".length);
	});

	test("update with append returns bodyLength without body", async () => {
		const filePath = await seedItem("drafts", "DRAFT-041-update-append-response", "Body append", {
			state: "ITEM",
			body: "Start",
		});
		const tool = makeTool();
		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-041-update-append-response",
			file: filePath,
			append: "\nMore detail",
		})) as Record<string, unknown>;

		expect(result.body).toBeUndefined();
		const fetched = (await tool.execute({ command: "get", id: "DRAFT-041-update-append-response" })) as {
			item: { body?: string };
		};
		expect(result.bodyLength).toBe((fetched.item.body ?? "").length);
	});

	test("update without body mutation omits body fields", async () => {
		const filePath = await seedItem("drafts", "DRAFT-042-update-state-response", "State only", {
			state: "ITEM",
			body: "Body stays",
		});
		const tool = makeTool();
		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-042-update-state-response",
			file: filePath,
			state: "DOING",
		})) as Record<string, unknown>;

		expect(result.body).toBeUndefined();
		expect(result.bodyLength).toBeUndefined();
	});
});
