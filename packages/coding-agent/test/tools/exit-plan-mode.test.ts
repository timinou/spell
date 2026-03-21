import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ExitPlanModeTool } from "@oh-my-pi/pi-coding-agent/tools/exit-plan-mode";

describe("ExitPlanModeTool", () => {
	let tmpDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exit-plan-mode-"));
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
			getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
			...overrides,
		};
	}

	async function writeOrgItem(
		category: "plans" | "features" | "bugs" | "projects",
		id: string,
		body: string,
	): Promise<void> {
		const categoryDir = path.join(tmpDir, "!tasks", category);
		await fs.mkdir(categoryDir, { recursive: true });
		const content = [
			`#+TITLE: ${id}`,
			`#+CUSTOM_ID: ${id}`,
			"#+STATE: ITEM",
			"#+EFFORT: 1h",
			"#+PRIORITY: #A",
			"#+LAYER: backend",
			"",
			body,
			"",
		].join("\n");
		await Bun.write(path.join(categoryDir, `${id}.org`), content);
	}

	it("requires title in schema", () => {
		const tool = new ExitPlanModeTool(createSession());
		const schema = tool.parameters as { required?: string[] };
		expect(schema.required).toContain("title");
	});

	it("requires itemId when org is enabled", async () => {
		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-org-required", { title: "WP_MIGRATION_PLAN" })).rejects.toThrow(
			"itemId is required when org is enabled. Provide the PLAN item's CUSTOM_ID.",
		);
	});

	it("normalizes title to .md final plan path for file-backed flow", async () => {
		const tool = new ExitPlanModeTool(createSession({ settings: Settings.isolated({ "org.enabled": false }) }));
		const result = await tool.execute("call-1", { title: "WP_MIGRATION_PLAN" });

		expect(result.details?.planFilePath).toBe("local://PLAN.md");
		expect(result.details?.title).toBe("WP_MIGRATION_PLAN");
		expect(result.details?.finalPlanFilePath).toBe("local://WP_MIGRATION_PLAN.md");
		expect(result.details?.planExists).toBe(true);
	});

	it("accepts explicit .md suffix in title for file-backed flow", async () => {
		const tool = new ExitPlanModeTool(createSession({ settings: Settings.isolated({ "org.enabled": false }) }));
		const result = await tool.execute("call-2", { title: "WP_MIGRATION_PLAN.md" });
		expect(result.details?.title).toBe("WP_MIGRATION_PLAN");
		expect(result.details?.finalPlanFilePath).toBe("local://WP_MIGRATION_PLAN.md");
	});

	it("fails early when the file-backed plan file was never written", async () => {
		await fs.rm(path.join(artifactsDir, "local", "PLAN.md"), { force: true });
		const tool = new ExitPlanModeTool(createSession({ settings: Settings.isolated({ "org.enabled": false }) }));

		await expect(tool.execute("call-missing", { title: "WP_MIGRATION_PLAN" })).rejects.toThrow(
			"Plan file not found at local://PLAN.md. Write the finalized plan to local://PLAN.md before calling exit_plan_mode.",
		);
	});

	it("rejects invalid title characters", async () => {
		const tool = new ExitPlanModeTool(createSession({ settings: Settings.isolated({ "org.enabled": false }) }));
		await expect(tool.execute("call-3", { title: "../bad" })).rejects.toThrow(
			"Title must not contain path separators or '..'.",
		);
		await expect(tool.execute("call-4", { title: "bad name" })).rejects.toThrow(
			"Title may only contain letters, numbers, underscores, hyphens, or dots.",
		);
	});

	it("returns org plan details with validated child ids", async () => {
		await writeOrgItem("features", "FEAT-001-auth-api", "* Scope\nImplement auth API");
		await writeOrgItem(
			"plans",
			"PLAN-001-auth-initiative",
			"* Context\nAuth rollout\n\n* Execution Manifest\n1. [[id:FEAT-001-auth-api]] (depends: none, effort: 1h)",
		);

		const tool = new ExitPlanModeTool(createSession());
		const result = await tool.execute("call-org", {
			title: "AUTH_INITIATIVE",
			itemId: "PLAN-001-auth-initiative",
		});

		expect(result.details?.itemId).toBe("PLAN-001-auth-initiative");
		expect(result.details?.childItemIds).toEqual(["FEAT-001-auth-api"]);
		expect(result.content[0]).toEqual({ type: "text", text: "Plan ready for approval (1 linked child items)." });
	});

	it("rejects org plan when child links are missing", async () => {
		await writeOrgItem(
			"plans",
			"PLAN-002-missing-child",
			"* Context\nAuth rollout\n\n* Execution Manifest\n1. [[id:BUG-999-does-not-exist]]",
		);

		const tool = new ExitPlanModeTool(createSession());
		await expect(
			tool.execute("call-missing-child", {
				title: "AUTH_INITIATIVE",
				itemId: "PLAN-002-missing-child",
			}),
		).rejects.toThrow('PLAN item "PLAN-002-missing-child" references missing child items: BUG-999-does-not-exist.');
	});

	it("rejects org plan without child links", async () => {
		await writeOrgItem("plans", "PLAN-003-no-links", "* Context\nAuth rollout\n\n* Execution Manifest\nNo links yet");

		const tool = new ExitPlanModeTool(createSession());
		await expect(
			tool.execute("call-no-links", {
				title: "AUTH_INITIATIVE",
				itemId: "PLAN-003-no-links",
			}),
		).rejects.toThrow(
			'PLAN item "PLAN-003-no-links" must include at least one child reference using [[id:...]] links in its body.',
		);
	});
});
