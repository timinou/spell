import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool } from "../src/tool";
import type { OrgConfig } from "../src/types";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-wave-flatten-"));
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

describe("org wave flatten output", () => {
	test("wave_returns_sub_outline_items", async () => {
		await seedFile(
			"DRAFT-020-alpha.org",
			[
				"#+TITLE: Alpha\n",
				"#+STATE: ITEM\n",
				"#+CUSTOM_ID: DRAFT-020-alpha\n",
				"\n",
				"* ITEM Alpha parent\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-020-alpha-parent\n",
				":END:\n",
				"** ITEM Alpha first\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-020-alpha-parent::first\n",
				":END:\n",
				"** ITEM Alpha second\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-020-alpha-parent::second\n",
				":DEPENDS: DRAFT-020-alpha-parent::first\n",
				":END:\n",
			].join(""),
		);
		await seedFile(
			"DRAFT-021-beta.org",
			[
				"#+TITLE: Beta\n",
				"#+STATE: ITEM\n",
				"#+CUSTOM_ID: DRAFT-021-beta\n",
				"\n",
				"* ITEM Beta parent\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-021-beta-parent\n",
				":END:\n",
				"** ITEM Beta first\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-021-beta-parent::first\n",
				":END:\n",
				"** ITEM Beta second\n",
				":PROPERTIES:\n",
				":CUSTOM_ID: DRAFT-021-beta-parent::second\n",
				":DEPENDS: DRAFT-021-beta-parent::first\n",
				":END:\n",
			].join(""),
		);

		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "wave", category: "drafts", manifest: true })) as {
			manifest: string;
			waves: Array<{ items: Array<{ custom_id: string; parent_id: string }> }>;
			warnings: string[];
		};
		const waveItems = result.waves.flatMap(wave => wave.items);
		const subOutlineItems = waveItems.filter(item => item.custom_id.includes("::"));
		expect(subOutlineItems.map(item => item.custom_id)).toEqual(
			expect.arrayContaining([
				"DRAFT-020-alpha-parent::first",
				"DRAFT-020-alpha-parent::second",
				"DRAFT-021-beta-parent::first",
				"DRAFT-021-beta-parent::second",
			]),
		);
		expect(subOutlineItems.map(item => item.parent_id)).toEqual(
			expect.arrayContaining(["DRAFT-020-alpha-parent", "DRAFT-021-beta-parent"]),
		);
		expect(result.manifest).toContain("[[id:DRAFT-020-alpha-parent::first]]");
		expect(result.warnings).toEqual([]);
	});
});
