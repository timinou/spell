import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool } from "../src/tool";
import type { OrgConfig } from "../src/types";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-cmd-rewrite-"));
	await fs.mkdir(path.join(tmpDir, "tasks", "drafts"), { recursive: true });
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(): OrgConfig {
	return {
		dirs: {
			tasks: {
				path: "tasks",
				categories: {
					drafts: { prefix: "DRAFT", path: "drafts" },
				},
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	};
}

function makeTool() {
	return createOrgTool(tmpDir, makeConfig());
}

async function seedItem(id: string, title: string, body?: string): Promise<string> {
	const filePath = path.join(tmpDir, "tasks", "drafts", `${id}.org`);
	await Bun.write(filePath, `#+TITLE: ${title}\n#+STATE: ITEM\n#+CUSTOM_ID: ${id}\n${body ? `\n${body}\n` : ""}`);
	return filePath;
}

async function readFile(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

describe("org rewrite integration paths", () => {
	test("update_section_rewrites_sub_outline_ids_in_body", async () => {
		const filePath = await seedItem(
			"DRAFT-001-section-body",
			"Section body target",
			"** Implementation\nOld section body",
		);
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-001-section-body",
			file: filePath,
			section: "Implementation",
			body: ["** Detail step", ":PROPERTIES:", ":CUSTOM_ID: detail-step", ":DEPENDS: ::detail-step", ":END:"].join(
				"\n",
			),
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		const content = await readFile(filePath);
		expect(content).toContain("** ITEM Detail step");
		expect(content).toContain(":CUSTOM_ID: DRAFT-001-section-body::detail-step");
		expect(content).toContain(":DEPENDS: DRAFT-001-section-body::detail-step");
	});

	test("update_section_rewrites_sub_outline_ids_in_append", async () => {
		const filePath = await seedItem(
			"DRAFT-002-section-append",
			"Section append target",
			"** Implementation\nExisting section body",
		);
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-002-section-append",
			file: filePath,
			section: "Implementation",
			append: ["", "** More detail", ":PROPERTIES:", ":CUSTOM_ID: ::more-detail", ":END:"].join("\n"),
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		const content = await readFile(filePath);
		expect(content).toContain("** ITEM More detail");
		expect(content).toContain(":CUSTOM_ID: DRAFT-002-section-append::more-detail");
	});

	test("update_append_rewrites_sub_outline_ids", async () => {
		const filePath = await seedItem("DRAFT-003-append", "Append target", "Existing body");
		const tool = makeTool();

		const result = (await tool.execute({
			command: "update",
			id: "DRAFT-003-append",
			file: filePath,
			append: ["", "** Add step", ":PROPERTIES:", ":CUSTOM_ID: add-step", ":DEPENDS: ::add-step", ":END:"].join(
				"\n",
			),
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		const content = await readFile(filePath);
		expect(content).toContain("** ITEM Add step");
		expect(content).toContain(":CUSTOM_ID: DRAFT-003-append::add-step");
		expect(content).toContain(":DEPENDS: DRAFT-003-append::add-step");
	});

	test("create_rewrites_and_injects_in_initial_body", async () => {
		const tool = makeTool();
		const body = ["* Scope", "** Define types", ":PROPERTIES:", ":CUSTOM_ID: ::define-types", ":END:"].join("\n");

		const result = (await tool.execute({
			command: "create",
			title: "Rewrite create",
			category: "drafts",
			body,
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(result.body).toContain("** ITEM Define types");
		expect(result.body).toContain(`:CUSTOM_ID: ${String(result.id)}::define-types`);
		expect(await readFile(String(result.file))).toContain(`:CUSTOM_ID: ${String(result.id)}::define-types`);
	});

	test("suboutline_add_emits_item_state_heading", async () => {
		const parentFile = await seedItem("DRAFT-004-parent", "Parent item", "* Scope\nBody");
		const tool = makeTool();

		const result = (await tool.execute({
			command: "suboutline-add",
			parentId: "DRAFT-004-parent",
			slug: "item-child",
			title: "Item child",
		})) as Record<string, unknown>;

		expect(result.success).toBe(true);
		expect(await readFile(parentFile)).toContain("** ITEM Item child");
	});
});
