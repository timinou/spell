import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult, TaskParams, TaskToolDetails } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "Base prompt",
	tools: ["read"],
	spawns: ["task"],
	source: "bundled",
};

function createResult(id: string, description: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: description,
		assignment: `## Target\n- Task: ${description}`,
		description,
		exitCode: 0,
		outcome: "completed",
		stderr: "",
		resultUri: `agent://${id}`,
		textPreview: description,
		durationMs: 1,
		tokens: 0,
	};
}

function createSession(tempDir: string, settings: Settings): ToolSession {
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => path.join(tempDir, "session.jsonl"),
		getSessionSpawns: () => "*",
		getCompactContext: () => undefined,
		getPlanModeState: () => undefined,
		getActiveModelString: () => undefined,
		getModelString: () => undefined,
		getArtifactsDir: () => path.join(tempDir, "artifacts"),
		getSessionId: () => "parent-session",
		settings,
		agentOutputManager: { allocateBatch: async (ids: string[]) => ids },
		authStorage: {} as never,
		modelRegistry: { refresh: async () => {} } as never,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
	} as unknown as ToolSession;
}

function buildParams(isolated: boolean | undefined, taskIds: string[]): TaskParams {
	const params: TaskParams = {
		agent: "task",
		tasks: taskIds.map(id => ({ id, description: id, assignment: `## Target\n- Task: ${id}` })),
	};
	if (isolated !== undefined) {
		(params as TaskParams & { isolated?: boolean }).isolated = isolated;
	}
	return params;
}

const DOWNGRADE_SENTINEL = "Task isolation was requested";

describe("TaskTool isolation downgrade", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-isolation-downgrade-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [baseAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("runs a single task non-isolated and surfaces the downgrade notice when mode=none and isolated:true", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => createResult(options.id, options.description ?? "task"));

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(tempDir, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })),
		);
		const result = await tool.execute("call-downgrade-single", buildParams(true, ["A"]));
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		const details = result.details as TaskToolDetails & { isolationDowngraded?: boolean };

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(text).toContain(DOWNGRADE_SENTINEL);
		expect(text).not.toContain("Task isolation is disabled");
		expect(details.isolationDowngraded).toBe(true);
		expect(details.results).toHaveLength(1);
	});

	it("runs every task in a multi-task batch non-isolated and emits the downgrade notice at most once", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => createResult(options.id, options.description ?? "task"));

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(tempDir, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })),
		);
		const result = await tool.execute("call-downgrade-batch", buildParams(true, ["A", "B", "C"]));
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		const details = result.details as TaskToolDetails & { isolationDowngraded?: boolean };
		const occurrences = text.split(DOWNGRADE_SENTINEL).length - 1;

		expect(runSpy).toHaveBeenCalledTimes(3);
		expect(occurrences).toBe(1);
		expect(details.isolationDowngraded).toBe(true);
		expect(details.results.map(r => r.id)).toEqual(["A", "B", "C"]);
	});

	it("does not flag downgrade when mode=none and isolated:false", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => createResult(options.id, options.description ?? "task"));

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(tempDir, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })),
		);
		const result = await tool.execute("call-explicit-false", buildParams(false, ["A"]));
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		const details = result.details as TaskToolDetails & { isolationDowngraded?: boolean };

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(text).not.toContain(DOWNGRADE_SENTINEL);
		expect(details.isolationDowngraded).toBeFalsy();
	});

	it("does not flag downgrade when mode=none and isolated is absent", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => createResult(options.id, options.description ?? "task"));

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(tempDir, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })),
		);
		const result = await tool.execute("call-isolated-absent", buildParams(undefined, ["A"]));
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		const details = result.details as TaskToolDetails & { isolationDowngraded?: boolean };

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(text).not.toContain(DOWNGRADE_SENTINEL);
		expect(details.isolationDowngraded).toBeFalsy();
	});
});
