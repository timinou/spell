import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools/index";

const READ_ONLY_PLAN_MODE_TOOLS = ["read", "grep", "find", "ls", "lsp", "fetch", "web_search", "org"];

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "Base prompt",
	tools: ["bash"],
	spawns: ["other"],
	source: "bundled",
};

function createSession(tempDir: string, settings: Settings): ToolSession {
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => path.join(tempDir, "session.jsonl"),
		getSessionSpawns: () => "*",
		getCompactContext: () => undefined,
		getPlanModeState: () => ({ type: "plan" as const, enabled: true, planFilePath: "PLAN.md" }),
		getActiveModelString: () => undefined,
		getModelString: () => undefined,
		getArtifactsDir: () => path.join(tempDir, "artifacts"),
		getSessionId: () => "session-a",
		settings,
		agentOutputManager: { allocateBatch: async (ids: string[]) => ids },
		authStorage: {} as never,
		modelRegistry: { refresh: async () => {} } as never,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
	} as unknown as ToolSession;
}

function createResult(): SingleResult {
	return {
		index: 0,
		id: "subtask-1",
		agent: "task",
		agentSource: "bundled",
		task: "Inspect file",
		assignment: "## Target\n- File: foo.ts",
		description: "Inspect file",
		exitCode: 0,
		outcome: "completed",
		stderr: "",
		resultUri: "agent://subtask-1",
		structuredResult: {},
		durationMs: 1,
		tokens: 0,
	};
}

describe("TaskTool plan mode tool narrowing", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-plan-mode-"));
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("keeps plan mode subagents read-only when no folders are configured", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
		});
		const runSubprocessSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult());
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir, settings));

		await tool.execute("call-readonly", {
			agent: "task",
			tasks: [{ id: "subtask1", description: "Inspect file", assignment: "## Target\n- File: foo.ts" }],
		});

		const call = runSubprocessSpy.mock.calls[0]?.[0];
		expect(call?.agent.tools).toEqual(READ_ONLY_PLAN_MODE_TOOLS);
		expect(call?.agent.tools).toContain("org");
		expect(call?.agent.tools).not.toContain("write");
		expect(call?.agent.spawns).toBeUndefined();
		expect(call?.agent.systemPrompt).not.toContain("Architecture notes and plan artifacts");
	});

	it("enables write and edit for plan mode subagents when folders are configured", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"planMode.allowedFolders": {
				"./docs/plans": "Architecture notes and plan artifacts",
			},
		});
		const runSubprocessSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult());
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir, settings));

		await tool.execute("call-writable", {
			agent: "task",
			tasks: [{ id: "subtask1", description: "Inspect file", assignment: "## Target\n- File: foo.ts" }],
		});

		const call = runSubprocessSpy.mock.calls[0]?.[0];
		expect(call?.agent.tools).toEqual([...READ_ONLY_PLAN_MODE_TOOLS, "write", "edit"]);
		expect(call?.agent.spawns).toBeUndefined();
		expect(call?.agent.systemPrompt).toContain("`./docs/plans`: Architecture notes and plan artifacts");
		expect(call?.agent.systemPrompt).toContain("You **MAY** create or edit files only in these configured folders:");
	});
});
