import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool } from "../src/tool";
import type { OrgConfig } from "../src/types";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-wave-plan-"));
	await fs.mkdir(path.join(tmpDir, "tasks", "plans"), { recursive: true });
	await fs.mkdir(path.join(tmpDir, "tasks", "features"), { recursive: true });
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
					plans: { prefix: "PLAN", path: "plans" },
					features: { prefix: "FEAT", path: "features" },
				},
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	};
}

async function seedFile(category: "plans" | "features", id: string, title: string, body: string): Promise<string> {
	const filePath = path.join(tmpDir, "tasks", category, `${id}.org`);
	await Bun.write(filePath, `#+TITLE: ${title}\n#+STATE: ITEM\n#+CUSTOM_ID: ${id}\n\n${body}\n`);
	return filePath;
}

async function readFile(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

function extractExecutionManifest(content: string): string | null {
	const match = /\* Execution Manifest\n[\s\S]*?(?=\n\* [^*]|$)/.exec(content);
	if (!match) return null;
	return match[0]!.trimEnd();
}

describe("org wave planItemId manifest flow", () => {
	test("wave_plan_item_id_walks_linked_children_and_returns_shape", async () => {
		await seedFile(
			"features",
			"FEAT-100",
			"Feature A",
			[
				"* ITEM Feature A work",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-100",
				":END:",
				"** ITEM Define API",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-100::api",
				":END:",
				"** ITEM Implement API",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-100::impl",
				":DEPENDS: FEAT-200::types",
				":END:",
			].join("\n"),
		);
		await seedFile(
			"features",
			"FEAT-200",
			"Feature B",
			[
				"* ITEM Feature B work",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-200",
				":END:",
				"** ITEM Define shared types",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-200::types",
				":END:",
			].join("\n"),
		);
		const planFile = await seedFile(
			"plans",
			"PLAN-100",
			"Plan item",
			["* Context", "- [[id:FEAT-100]]", "- [[id:FEAT-200]]", "* Verification", "- pending"].join("\n"),
		);

		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "wave", manifest: true, planItemId: "PLAN-100" })) as Record<
			string,
			unknown
		>;
		const waves = result.waves as Array<{ items: Array<{ custom_id: string }> }>;
		const flattened = waves.flatMap(wave => wave.items.map(item => item.custom_id));
		expect(flattened).toEqual(expect.arrayContaining(["FEAT-100::api", "FEAT-100::impl", "FEAT-200::types"]));
		expect(result.wrote_to_plan).toBe(true);
		expect(result.plan_file).toBe(planFile);
		expect(result.plan_item_id).toBe("PLAN-100");
		expect(typeof result.manifest).toBe("string");
		expect(result).toHaveProperty("total_sub_outlines");
		expect((result.manifest as string).indexOf("[[id:FEAT-200::types]]")).toBeLessThan(
			(result.manifest as string).indexOf("[[id:FEAT-100::impl]]"),
		);
	});

	test("wave_plan_item_writes_and_replaces_manifest_section", async () => {
		await seedFile(
			"features",
			"FEAT-110",
			"Feature",
			[
				"* ITEM Feature work",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-110",
				":END:",
				"** ITEM Define types",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-110::types",
				":END:",
			].join("\n"),
		);
		const planFile = await seedFile(
			"plans",
			"PLAN-110",
			"Plan item",
			["* Context", "- [[id:FEAT-110]]", "* Execution Manifest", "stale manifest", "* Verification", "- keep"].join(
				"\n",
			),
		);

		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "wave", manifest: true, planItemId: "PLAN-110" })) as {
			manifest: string;
		};
		const content = await readFile(planFile);
		expect(content).not.toContain("stale manifest");
		expect(content).toContain("* Context");
		expect(content).toContain("* Verification");
		expect(extractExecutionManifest(content)).toBe(result.manifest.trimEnd());
		expect(content.match(/\* Execution Manifest/g)?.length).toBe(1);
	});

	test("wave_plan_item_appends_when_missing_and_returns_text_to_caller", async () => {
		await seedFile(
			"features",
			"FEAT-120",
			"Feature",
			[
				"* ITEM Feature work",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-120",
				":END:",
				"** ITEM Ship",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-120::ship",
				":END:",
			].join("\n"),
		);
		const planFile = await seedFile("plans", "PLAN-120", "Plan item", ["* Context", "- [[id:FEAT-120]]"].join("\n"));

		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "wave", manifest: true, planItemId: "PLAN-120" })) as {
			manifest: string;
		};
		const content = await readFile(planFile);
		expect(content).toContain("* Execution Manifest");
		expect(extractExecutionManifest(content)).toBe(result.manifest.trimEnd());
		expect(result.manifest).toContain("** wave-1 :wave:");
	});

	test("wave_plan_item_handles_plan_without_children", async () => {
		const planFile = await seedFile("plans", "PLAN-130", "Plan item", "* Context\nNo child links here.");
		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "wave", manifest: true, planItemId: "PLAN-130" })) as Record<
			string,
			unknown
		>;
		expect(result.warnings).toEqual(["no linked child items; manifest not written"]);
		expect(result.wrote_to_plan).toBe(false);
		expect(result.plan_file).toBe(planFile);
		expect(await readFile(planFile)).not.toContain("* Execution Manifest");
	});

	test("wave_without_plan_item_id_preserves_existing_behavior", async () => {
		await seedFile(
			"features",
			"FEAT-140",
			"Feature",
			[
				"* ITEM Feature work",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-140",
				":END:",
				"** ITEM Ship",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-140::ship",
				":END:",
			].join("\n"),
		);
		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({ command: "wave", category: "features", manifest: true })) as Record<
			string,
			unknown
		>;
		expect(result).toHaveProperty("manifest");
		expect(result).toHaveProperty("waves");
		expect(result).not.toHaveProperty("wrote_to_plan");
		expect(result).not.toHaveProperty("plan_file");
	});
});
