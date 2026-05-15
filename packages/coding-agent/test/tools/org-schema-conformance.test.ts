/**
 * Schema conformance tests for the agent-facing org tool (BUG-367).
 *
 * Ensures the TypeBox schema advertises all subcommands and fields that the
 * underlying dispatcher already supports.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { OrgTool } from "@oh-my-pi/pi-coding-agent/tools/org";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Value } from "@sinclair/typebox/value";

const ALL_SUBCOMMANDS = [
	"init",
	"create",
	"query",
	"get",
	"update",
	"note",
	"set",
	"validate",
	"delete",
	"validate-plan",
	"dashboard",
	"wave",
	"graph",
	"archive",
	"suboutline-add",
	"recall",
	"remember",
	"timeline",
	"subgraph",
	"link",
];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-schema-"));
	// Seed default category dirs so createOrgTool can resolve categories
	await fs.mkdir(path.join(tmpDir, "tasks", "plans"), { recursive: true });
	await fs.mkdir(path.join(tmpDir, "tasks", "projects"), { recursive: true });
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function createSession(): ToolSession {
	return {
		cwd: tmpDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "test-session",
		getFirstUserMessage: () => "Schema conformance",
		settings: Settings.isolated(),
	};
}

async function seedParentItem(id: string, title: string): Promise<string> {
	const dir = path.join(tmpDir, "tasks", "projects");
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${id}.org`);
	const content = `#+TITLE: ${title}\n#+STATE: ITEM\n#+CUSTOM_ID: ${id}\n\n* Scope\nBody\n`;
	await Bun.write(filePath, content);
	return filePath;
}

describe("orgSchema command description", () => {
	it("enumerates all 20 subcommands", async () => {
		const tool = new OrgTool(createSession());
		const desc = tool.description;
		for (const cmd of ALL_SUBCOMMANDS) {
			expect(desc).toContain(cmd);
		}
		await tool.dispose();
	});
});

describe("orgSchema parameters", () => {
	it("declares parentId, slug, and depends as optional fields", async () => {
		const tool = new OrgTool(createSession());
		const schema = tool.parameters as { properties?: Record<string, unknown> };

		expect(schema.properties).toBeDefined();
		expect(schema.properties).toHaveProperty("parentId");
		expect(schema.properties).toHaveProperty("slug");
		expect(schema.properties).toHaveProperty("depends");

		// Validation should accept objects that include these fields
		expect(
			Value.Check(tool.parameters, {
				command: "suboutline-add",
				parentId: "PROJ-001",
				slug: "wire-types",
				title: "Wire types",
				depends: ["PROJ-001::define-types"],
			}),
		).toBe(true);

		// And accept omission (they are optional)
		expect(
			Value.Check(tool.parameters, {
				command: "suboutline-add",
				parentId: "PROJ-001",
				slug: "wire-types",
				title: "Wire types",
			}),
		).toBe(true);

		await tool.dispose();
	});
});

describe("suboutline-add end-to-end", () => {
	it("succeeds through the coding-agent OrgTool with {parentId, slug, title}", async () => {
		await seedParentItem("PROJ-NNN-parent", "Parent item");
		const tool = new OrgTool(createSession());

		const result = await tool.execute("tc-1", {
			command: "suboutline-add",
			parentId: "PROJ-NNN-parent",
			slug: "wire-types",
			title: "Wire types",
		} as any);

		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text: string }).text)
			.join("");
		const parsed = JSON.parse(text) as Record<string, unknown>;

		expect(parsed.error).toBeUndefined();
		expect(parsed.success).toBe(true);
		expect(parsed.suboutlineId).toBe("PROJ-NNN-parent::wire-types");

		await tool.dispose();
	});
});
