import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, AgentProgress, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import type { TodoGroup } from "../../src/tools/todo-write";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "Base prompt",
	tools: ["read"],
	spawns: ["task"],
	source: "bundled",
};

function createResult(id: string, transcriptPath: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Build feature",
		assignment: "## Target\n- File: foo.ts",
		description: "Build feature",
		exitCode: 0,
		outcome: "completed",
		stderr: "",
		resultUri: `agent://${id}`,
		structuredResult: {},
		durationMs: 1,
		tokens: 0,
		sessionId: "child-session",
		transcriptUri: transcriptPath,
		...overrides,
	};
}

function createSession(
	tempDir: string,
	settings: Settings,
	initialGroups: TodoGroup[],
): ToolSession & { snapshots: TodoGroup[][] } {
	let groups = structuredClone(initialGroups);
	const snapshots: TodoGroup[][] = [];
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
		getTodoGroups: () => groups,
		setTodoGroups: (next: TodoGroup[]) => {
			groups = structuredClone(next);
			snapshots.push(structuredClone(next));
		},
		settings,
		agentOutputManager: { allocateBatch: async (ids: string[]) => ids },
		authStorage: {} as never,
		modelRegistry: { refresh: async () => {} } as never,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		snapshots,
	} as unknown as ToolSession & { snapshots: TodoGroup[][] };
}

function mockRunSubprocess(transcriptPath: string, overrides: Partial<SingleResult> = {}): void {
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		const progress: AgentProgress = {
			index: 0,
			id: options.id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: options.task,
			assignment: options.assignment,
			description: options.description,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			sessionId: "child-session",
			transcriptPath,
		};
		options.onProgress?.(progress);
		return createResult(options.id, transcriptPath, overrides);
	});
}

describe("child phase gate propagation", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-child-gates-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("keeps the parent delegated task completed when child gated todos pass", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{ id: "phase-1", name: "Work", tasks: [{ id: "task-1", content: "Parent task", status: "pending" }] },
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		mockRunSubprocess(transcriptPath, {
			todoGroups: [
				{
					id: "phase-child-1",
					name: "Child work",
					tasks: [{ id: "child-task-1", content: "Run child tests", status: "completed", gateCmd: "bun test" }],
				},
			],
			extractedToolData: { bash: [{ command: "bun test", exitCode: 0, cwd: tempDir }] },
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);
		await tool.execute("call-1", {
			agent: "task",
			tasks: [
				{ id: "sub1", description: "Build feature", assignment: "## Target\n- File: foo.ts", todoRef: "task-1" },
			],
		});

		const finalTask = session.snapshots.at(-1)?.[0]?.tasks[0];
		expect(finalTask?.status).toBe("completed");
		expect(finalTask?.delegation?.result?.gateFailures).toBeUndefined();
	});

	it("marks the parent delegated task gate_failed when a completed child gated todo lacks evidence", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{ id: "phase-1", name: "Work", tasks: [{ id: "task-1", content: "Parent task", status: "pending" }] },
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		mockRunSubprocess(transcriptPath, {
			todoGroups: [
				{
					id: "phase-child-1",
					name: "Child work",
					tasks: [{ id: "child-task-1", content: "Run child tests", status: "completed", gateCmd: "bun test" }],
				},
			],
			extractedToolData: { bash: [{ command: "bun check", exitCode: 0, cwd: tempDir }] },
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);
		await tool.execute("call-1", {
			agent: "task",
			tasks: [
				{ id: "sub1", description: "Build feature", assignment: "## Target\n- File: foo.ts", todoRef: "task-1" },
			],
		});

		const finalTask = session.snapshots.at(-1)?.[0]?.tasks[0];
		expect(finalTask?.status).toBe("gate_failed");
		expect(finalTask?.delegation?.result?.gateFailures?.[0]?.taskId).toBe("child-task-1");
		expect(finalTask?.delegation?.result?.gateFailures?.[0]?.gate).toBe("gateCmd");
	});
});
