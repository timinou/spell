import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, AgentProgress, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import type { TodoPhase } from "../../src/tools/todo-write";

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
		task: "Inspect file",
		assignment: "## Target\n- File: foo.ts",
		description: "Inspect file",
		exitCode: 0,
		output: "{}",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		sessionId: "child-session",
		transcriptPath,
		...overrides,
	};
}

function createSession(
	tempDir: string,
	settings: Settings,
	initialPhases: TodoPhase[],
): ToolSession & { snapshots: TodoPhase[][] } {
	let phases = initialPhases;
	const snapshots: TodoPhase[][] = [];
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
		getTodoPhases: () => phases,
		setTodoPhases: (next: TodoPhase[]) => {
			phases = structuredClone(next);
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
	} as unknown as ToolSession & { snapshots: TodoPhase[][] };
}

describe("TaskTool todoRef lifecycle", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-todoref-lifecycle-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("marks linked parent todo in_progress on spawn and completed on success", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{ id: "phase-1", name: "Work", tasks: [{ id: "task-1", content: "Inspect file", status: "pending" }] },
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask1.jsonl");
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
				todoPhases: [
					{
						id: "child-phase-1",
						name: "Delegated Work",
						tasks: [{ id: "child-task-1", content: "Read file", status: "in_progress" }],
					},
				],
			};
			options.onProgress?.(progress);
			return createResult(options.id, transcriptPath, { todoPhases: progress.todoPhases });
		});
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-success", {
			agent: "task",
			tasks: [
				{ id: "subtask1", description: "Inspect file", assignment: "## Target\n- File: foo.ts", todoRef: "task-1" },
			],
		});

		expect(session.snapshots.length).toBeGreaterThanOrEqual(2);
		const runningSnapshot = session.snapshots.find(snapshot => snapshot[0]?.tasks[0]?.status === "in_progress");
		expect(runningSnapshot?.[0]?.tasks[0]).toMatchObject({
			status: "in_progress",
			delegation: {
				agent: "task",
				sessionId: "child-session",
				transcriptPath,
			},
		});
		const finalTask = session.snapshots.at(-1)?.[0]?.tasks[0];
		expect(finalTask).toMatchObject({
			status: "completed",
			delegation: {
				agent: "task",
				sessionId: "child-session",
				transcriptPath,
				childPhases: [
					{
						name: "Delegated Work",
						tasks: [{ content: "Read file", status: "in_progress" }],
					},
				],
			},
		});
	});

	it("marks linked parent todo failed when delegated subagent errors", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{ id: "phase-1", name: "Work", tasks: [{ id: "task-1", content: "Inspect file", status: "pending" }] },
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask1.jsonl");
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			options.onProgress?.({
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
			});
			return createResult(options.id, transcriptPath, {
				exitCode: 1,
				stderr: "boom",
				error: "boom",
			});
		});
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-fail", {
			agent: "task",
			tasks: [
				{ id: "subtask1", description: "Inspect file", assignment: "## Target\n- File: foo.ts", todoRef: "task-1" },
			],
		});

		expect(session.snapshots.length).toBeGreaterThanOrEqual(2);
		const finalTask = session.snapshots.at(-1)?.[0]?.tasks[0];
		expect(finalTask).toMatchObject({
			status: "failed",
			delegation: {
				agent: "task",
				sessionId: "child-session",
				transcriptPath,
			},
		});
	});
});
