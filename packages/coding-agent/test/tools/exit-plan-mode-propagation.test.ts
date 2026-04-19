import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { ExitPlanModeTool } from "../../src/tools/exit-plan-mode";

describe("ExitPlanModeTool child item propagation", () => {
	let tmpDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exit-plan-mode-propagation-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
		await Bun.write(path.join(artifactsDir, "local", "PLAN.md"), "# Plan\n");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "session-a",
			getPlanModeState: () => ({ type: "plan" as const, enabled: true, planFilePath: "local://PLAN.md" }),
			getLastApprovedPlan: () => undefined,
			...overrides,
		};
	}

	async function writeOrgItem(category: string, id: string, body: string): Promise<string> {
		const categoryDir = path.join(tmpDir, "!tasks", category);
		await fs.mkdir(categoryDir, { recursive: true });
		const filePath = path.join(categoryDir, `${id}.org`);
		const content = [
			`#+TITLE: ${id}`,
			`#+CUSTOM_ID: ${id}`,
			"#+STATE: ITEM",
			"#+LAYER: coding-agent",
			"",
			body,
			"",
		].join("\n");
		await Bun.write(filePath, content);
		return filePath;
	}

	test("threads ordered child item specs into org-backed exit details", async () => {
		await writeOrgItem(
			"features",
			"FEAT-001-foo",
			[
				"* Scope",
				"Implement the first feature with concrete file paths and acceptance details so validation passes cleanly.",
				"",
				"** Step one",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-001-foo::step-one",
				":END:",
				"- File: src/feature-one.ts",
				"- Acceptance: emits child spec bodies.",
			].join("\n"),
		);
		await writeOrgItem(
			"features",
			"FEAT-002-bar",
			[
				"* Scope",
				"Implement the second feature with enough narrative to keep the body comfortably above validation thresholds.",
				"",
				"** Step two",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-002-bar::step-two",
				":END:",
				"- File: src/feature-two.ts",
				"- Acceptance: preserves ordering.",
			].join("\n"),
		);
		await writeOrgItem(
			"plans",
			"PLAN-001-demo",
			[
				"* Context",
				"Demonstration plan.",
				"",
				"* Execution Manifest",
				"- [[id:FEAT-001-foo]] First feature",
				"- [[id:FEAT-002-bar]] Second feature",
			].join("\n"),
		);

		const tool = new ExitPlanModeTool(createSession());
		const result = await tool.execute("call-org", { title: "PLAN_DEMO", itemId: "PLAN-001-demo" });
		const childItems = result.details?.childItems ?? [];

		expect(result.details?.childItemIds).toEqual(["FEAT-001-foo", "FEAT-002-bar"]);
		expect(childItems).toHaveLength(2);
		expect(childItems.map(childItem => childItem.id)).toEqual(["FEAT-001-foo", "FEAT-002-bar"]);
		expect(childItems[0]?.body).toContain("* Scope");
		expect(childItems[1]?.body).toContain("* Scope");
	});

	test("leaves child item specs undefined for file-backed approval", async () => {
		const tool = new ExitPlanModeTool(createSession({ settings: Settings.isolated({ "org.enabled": false }) }));
		const result = await tool.execute("call-file", { title: "PLAN_DEMO" });
		expect(result.details?.childItems).toBeUndefined();
	});
});
