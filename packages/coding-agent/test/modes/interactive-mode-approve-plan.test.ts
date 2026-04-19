import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "../../src/config/settings";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { initTheme } from "../../src/modes/theme/theme";
import type { ExitPlanModeDetails } from "../../src/tools";
import type { TodoGroup } from "../../src/tools/todo-write";

describe("InteractiveMode plan approval todo details", () => {
	let tmpDir: string;

	beforeEach(async () => {
		_resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "interactive-mode-approve-plan-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
		await initTheme(false);
	});

	afterEach(async () => {
		_resetSettingsForTest();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("seeds todo details from the owning child sub-outline when approving a waved plan", async () => {
		const planId = "PLAN-272-demo";
		const planFile = path.join(tmpDir, "!tasks", "plans", `${planId}.org`);
		await fs.mkdir(path.dirname(planFile), { recursive: true });
		await Bun.write(
			planFile,
			[
				`#+TITLE: ${planId}`,
				`#+CUSTOM_ID: ${planId}`,
				"#+STATE: INIT",
				"#+LAYER: coding-agent",
				"",
				"* Context",
				"Plan body.",
			].join("\n"),
		);

		let seededGroups: TodoGroup[] = [];
		const prompts: string[] = [];
		const showError = vi.fn();
		const settings = Settings.isolated();
		const session = {
			settings,
			sessionManager: {
				getCwd: () => tmpDir,
				getSessionFile: () => null,
				getArtifactsDir: () => path.join(tmpDir, ".artifacts"),
				getSessionId: () => "session-a",
				appendModeChange: () => {},
				getUsageStatistics: () => ({
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
			agent: {},
			autoCompactionEnabled: false,
			extensionRunner: undefined,
			customCommands: [],
			skills: [],
			state: { messages: [] },
			messages: [{ role: "user", attribution: "user", content: "seed todos from child bodies" }],
			isStreaming: false,
			isFastModeEnabled: () => false,
			getAsyncJobSnapshot: () => ({ running: [] }),
			getActiveToolNames: () => [],
			setActiveToolsByName: async () => {},
			setModelTemporary: async () => {},
			setPlanModeState: () => {},
			getPlanModeState: () => undefined,
			getModeConfig: () => undefined,
			setPlanReferencePath: () => {},
			recordLastApprovedPlan: () => {},
			markPlanReferenceSent: () => {},
			setAuditState: () => {},
			setTodoGroups: (groups: TodoGroup[]) => {
				seededGroups = groups;
			},
			prompt: async (prompt: string) => {
				prompts.push(prompt);
			},
			abort: async () => {},
		} as never;
		const mode = new InteractiveMode(session, "test-version");
		mode.ui.requestRender = vi.fn();
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = "org://PLAN-272-demo";
		mode.showHookSelector = vi.fn(async () => "Approve and execute");
		mode.handleClearCommand = vi.fn(async () => undefined);
		mode.showError = showError;

		const details: ExitPlanModeDetails = {
			planFilePath: "org://PLAN-272-demo",
			planExists: true,
			title: "PLAN_272_DEMO",
			finalPlanFilePath: "org://PLAN-272-demo",
			itemId: planId,
			orgItemFile: planFile,
			planContent: [
				"* Context",
				"Plan body.",
				"",
				"* Execution Manifest",
				"** plumbing :wave:",
				"- [[id:FEAT-601-inject-linked-child-org-bodies-into-appr::s4-template]] Insert block",
			].join("\n"),
			childItemIds: ["FEAT-601-inject-linked-child-org-bodies-into-appr"],
			childItems: [
				{
					id: "FEAT-601-inject-linked-child-org-bodies-into-appr",
					body: [
						"* Scope",
						"Thread every linked child item into the approved plan prompt.",
						"",
						"** s4",
						":PROPERTIES:",
						":CUSTOM_ID: FEAT-601-inject-linked-child-org-bodies-into-appr::s4-template",
						":END:",
						"- File: src/prompts/system/plan-mode-approved.md",
						"- Insert block",
					].join("\n"),
					properties: { LAYER: "coding-agent" },
				},
			],
			waves: [
				{
					name: "plumbing",
					entries: [
						{
							id: "FEAT-601-inject-linked-child-org-bodies-into-appr::s4-template",
							orgItemId: "FEAT-601-inject-linked-child-org-bodies-into-appr::s4-template",
							step: "Insert block",
						},
					],
				},
			],
		};

		await mode.handleExitPlanModeTool(details);

		if (showError.mock.calls.length > 0) {
			throw new Error(showError.mock.calls[0]?.[0] ?? "unknown showError call");
		}

		expect(seededGroups).toHaveLength(1);
		expect(seededGroups[0]?.tasks[0]?.details).toBe(
			["- File: src/prompts/system/plan-mode-approved.md", "- Insert block"].join("\n"),
		);
		expect(seededGroups[0]?.planItemId).toBe(planId);
		expect(prompts.at(-1)).toContain("## Child Item Specifications");
	});
});
