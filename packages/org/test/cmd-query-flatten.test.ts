import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool } from "../src/tool";
import type { OrgConfig } from "../src/types";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-query-flatten-"));
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

async function seedFile(fileName: string, content: string): Promise<void> {
	await Bun.write(path.join(tmpDir, "tasks", "drafts", fileName), content);
}

describe("org query flatten guards", () => {
	test("query_still_returns_top_level_only_by_default", async () => {
		await seedFile(
			"DRAFT-010-alpha.org",
			[
				"#+TITLE: Alpha\n",
				"#+STATE: ITEM\n",
				"#+CUSTOM_ID: DRAFT-010-alpha\n",
				"\n",
				"* ITEM Alpha parent\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-010-alpha-parent\n",
				":END:\n",
				"** ITEM Alpha child\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-010-alpha-parent::child\n",
				":END:\n",
			].join(""),
		);
		await seedFile(
			"DRAFT-011-beta.org",
			[
				"#+TITLE: Beta\n",
				"#+STATE: ITEM\n",
				"#+CUSTOM_ID: DRAFT-011-beta\n",
				"\n",
				"* ITEM Beta parent\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-011-beta-parent\n",
				":END:\n",
				"** ITEM Beta child\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-011-beta-parent::child\n",
				":END:\n",
			].join(""),
		);

		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "query", category: "drafts" })) as { items: Array<{ id: string }> };
		expect(result.items).toHaveLength(2);
		expect(result.items.map(item => item.id).sort()).toEqual(["DRAFT-010-alpha", "DRAFT-011-beta"]);
	});
});
