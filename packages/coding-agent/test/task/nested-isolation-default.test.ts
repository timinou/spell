import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "../../src/task/types";
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
		output: description,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
	};
}

function createSession(tempDir: string, taskDepth: number, settings: Settings): ToolSession {
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
		taskDepth,
		agentOutputManager: { allocateBatch: async (ids: string[]) => ids },
		authStorage: {} as never,
		modelRegistry: { refresh: async () => {} } as never,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
	} as unknown as ToolSession;
}

function buildParams(isolated: boolean | undefined, taskDefs: Array<{ id: string; filesDeps?: string[] }>): TaskParams {
	const params: TaskParams = {
		agent: "task",
		tasks: taskDefs.map(task => ({
			id: task.id,
			description: task.id,
			assignment: `## Target\n- Task: ${task.id}`,
			...(task.filesDeps ? { filesDeps: task.filesDeps } : {}),
		})),
	};
	if (isolated !== undefined) {
		(params as TaskParams & { isolated?: boolean }).isolated = isolated;
	}
	return params;
}

describe("TaskTool nested isolation defaults", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-nested-isolation-default-"));
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

	it("keeps depth=0 opt-in only", async () => {
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => createResult(options.id, options.description ?? "task"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir, 0, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "worktree" })));

		await tool.execute("depth-zero-batch", buildParams(undefined, [{ id: "A" }, { id: "B" }]));

		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(runSpy.mock.calls.every(call => call[0].isolation === true)).toBeFalse();
	});

	it("auto-coerces depth>=1 for batch size", async () => {
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => createResult(options.id, options.description ?? "task"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir, 1, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "worktree" })));

		await tool.execute("depth-one-batch", buildParams(undefined, [{ id: "A" }, { id: "B" }]));

		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(runSpy.mock.calls.every(call => call[0].isolation === true)).toBeTrue();
	});

	it("auto-coerces depth>=1 for code-supported file scope", async () => {
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => createResult(options.id, options.description ?? "task"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir, 1, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "worktree" })));

		await tool.execute("depth-one-code-scope", buildParams(undefined, [{ id: "A", filesDeps: ["src/example.ts"] }]));

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0].isolation).toBeTrue();
	});

	it("respects explicit isolated:false opt-out", async () => {
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => createResult(options.id, options.description ?? "task"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir, 1, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "worktree" })));

		await tool.execute("depth-one-explicit-false", buildParams(false, [{ id: "A" }, { id: "B", filesDeps: ["src/example.ts"] }]));

		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(runSpy.mock.calls.every(call => call[0].isolation === true)).toBeFalse();
	});

	it("preserves downgrade behavior when isolationMode=none", async () => {
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => createResult(options.id, options.description ?? "task"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir, 1, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })));

		const result = await tool.execute("depth-one-mode-none", buildParams(true, [{ id: "A" }, { id: "B", filesDeps: ["src/example.ts"] }]));
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		const details = result.details as { isolationDowngraded?: boolean };

		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(text).toContain('Task isolation was requested but task.isolation.mode="none"; running non-isolated.');
		expect(details.isolationDowngraded).toBeTrue();
	});
});
