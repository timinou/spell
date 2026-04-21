import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool } from "../src/tool";
import type { OrgConfig } from "../src/types";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-wave-duplicate-"));
	await fs.mkdir(path.join(tmpDir, "tasks", "features"), { recursive: true });
	await fs.mkdir(path.join(tmpDir, "tasks", "plans"), { recursive: true });
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
					features: { prefix: "FEAT", path: "features" },
					plans: { prefix: "PLAN", path: "plans" },
				},
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	};
}

async function seedFile(category: "features" | "plans", fileName: string, content: string): Promise<string> {
	const filePath = path.join(tmpDir, "tasks", category, fileName);
	await Bun.write(filePath, `${content}\n`);
	return filePath;
}

describe("org wave duplicate CUSTOM_ID diagnostics", () => {
	test("wave returns duplicate-id error for next-wave path", async () => {
		await seedFile(
			"features",
			"dup-a.org",
			[
				"#+TITLE: Duplicate A",
				"#+STATE: ITEM",
				"#+CUSTOM_ID: DUP-A",
				"",
				"* ITEM Duplicate A",
				":PROPERTIES:",
				":CUSTOM_ID: DUP-A",
				":END:",
			].join("\n"),
		);
		await seedFile(
			"features",
			"dup-b.org",
			[
				"#+TITLE: Duplicate B",
				"#+STATE: ITEM",
				"#+CUSTOM_ID: DUP-A",
				"",
				"* ITEM Duplicate B",
				":PROPERTIES:",
				":CUSTOM_ID: DUP-A",
				":END:",
			].join("\n"),
		);

		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "wave", category: "features" })) as Record<string, unknown>;

		expect(result).toEqual({
			code: "DUPLICATE_CUSTOM_ID",
			duplicate_ids: ["DUP-A"],
			duplicate_count: 1,
			message: "duplicate CUSTOM_ID values in wave input: DUP-A",
		});
	});

	test("wave returns deterministic duplicate-id error for manifest path", async () => {
		await seedFile(
			"features",
			"dup-z.org",
			["#+TITLE: Duplicate Z", "#+STATE: ITEM", "#+CUSTOM_ID: DUP-Z"].join("\n"),
		);
		await seedFile(
			"features",
			"dup-a.org",
			["#+TITLE: Duplicate A", "#+STATE: ITEM", "#+CUSTOM_ID: DUP-A"].join("\n"),
		);
		await seedFile(
			"features",
			"dup-z-second.org",
			["#+TITLE: Duplicate Z second", "#+STATE: ITEM", "#+CUSTOM_ID: DUP-Z"].join("\n"),
		);
		await seedFile(
			"features",
			"dup-a-second.org",
			["#+TITLE: Duplicate A second", "#+STATE: ITEM", "#+CUSTOM_ID: DUP-A"].join("\n"),
		);

		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "wave", category: "features", manifest: true })) as Record<
			string,
			unknown
		>;

		expect(result).toEqual({
			code: "DUPLICATE_CUSTOM_ID",
			duplicate_ids: ["DUP-A", "DUP-Z"],
			duplicate_count: 2,
			message: "duplicate CUSTOM_ID values in wave input: DUP-A, DUP-Z",
		});
	});

	test("wave plan manifest preserves duplicate linked children for diagnostics", async () => {
		await seedFile(
			"features",
			"FEAT-300-primary.org",
			[
				"#+TITLE: Feature 300 primary",
				"#+STATE: ITEM",
				"#+CUSTOM_ID: FEAT-300",
				"",
				"* ITEM Feature 300 primary",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-300",
				":END:",
				"** ITEM Shared child",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-300::shared",
				":END:",
			].join("\n"),
		);
		await seedFile(
			"features",
			"FEAT-300-shadow.org",
			[
				"#+TITLE: Feature 300 shadow",
				"#+STATE: ITEM",
				"#+CUSTOM_ID: FEAT-300",
				"",
				"* ITEM Feature 300 shadow",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-300",
				":END:",
				"** ITEM Shared child again",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-300::shared",
				":END:",
			].join("\n"),
		);
		await seedFile(
			"plans",
			"PLAN-300.org",
			[
				"#+TITLE: Plan 300",
				"#+STATE: ITEM",
				"#+CUSTOM_ID: PLAN-300",
				"",
				"* Context",
				"- [[id:FEAT-300]]",
				"* Verification",
				"- pending",
			].join("\n"),
		);

		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "wave", manifest: true, planItemId: "PLAN-300" })) as Record<
			string,
			unknown
		>;

		expect(result).toEqual({
			code: "DUPLICATE_CUSTOM_ID",
			duplicate_ids: ["FEAT-300::shared"],
			duplicate_count: 1,
			message: "duplicate CUSTOM_ID values in wave input: FEAT-300::shared",
		});
	});
});
