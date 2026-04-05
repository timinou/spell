/**
 * Tests for gate enforcement in #finalizeTodoRef.
 *
 * Contracts:
 *   - When subagent succeeds (exitCode 0) and gates are satisfied, todo status = "completed"
 *   - When subagent succeeds but gates are NOT satisfied, todo status = "gate_failed"
 *   - When subagent fails (exitCode != 0), gates are NOT checked, todo status = "failed"
 *   - gate_failed tasks carry gateFailures in delegation.result
 *   - Tasks with no gates are unaffected (completed as before)
 *   - Tasks with no todoRef skip gate checking entirely
 */
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
		task: "Build feature",
		assignment: "## Target\n- File: foo.ts",
		description: "Build feature",
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

describe("Gate enforcement in finalizeTodoRef", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-gate-enforce-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("marks todo completed when subagent succeeds and no gates are set", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{ id: "phase-1", name: "Work", tasks: [{ id: "task-1", content: "Build feature", status: "pending" }] },
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		mockRunSubprocess(transcriptPath);

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
	});

	it("marks todo completed when subagent succeeds and gateCmd is satisfied", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{
				id: "phase-1",
				name: "Work",
				tasks: [{ id: "task-1", content: "Build feature", status: "pending", gateCmd: "bun test" }],
			},
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		mockRunSubprocess(transcriptPath, {
			extractedToolData: { bash: [{ command: "bun test", exitCode: 0 }] },
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
	});

	it("marks todo gate_failed when subagent succeeds but gateCmd is NOT satisfied", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{
				id: "phase-1",
				name: "Work",
				tasks: [{ id: "task-1", content: "Build feature", status: "pending", gateCmd: "bun test" }],
			},
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		// Subagent succeeds but never ran `bun test`
		mockRunSubprocess(transcriptPath, {
			extractedToolData: { bash: [{ command: "bun check", exitCode: 0 }] },
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
		expect(finalTask?.delegation?.result?.gateFailures).toBeDefined();
		expect(finalTask?.delegation?.result?.gateFailures?.length).toBe(1);
		expect(finalTask?.delegation?.result?.gateFailures?.[0]?.gate).toBe("gateCmd");
	});

	it("marks todo gate_failed when gateCommit is required but no git commit in bash history", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{
				id: "phase-1",
				name: "Work",
				tasks: [{ id: "task-1", content: "Build feature", status: "pending", gateCommit: true }],
			},
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		// No git commit in history
		mockRunSubprocess(transcriptPath, {
			extractedToolData: { bash: [{ command: "bun test", exitCode: 0 }] },
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
		expect(finalTask?.delegation?.result?.gateFailures?.[0]?.gate).toBe("gateCommit");
	});

	it("marks todo gate_failed when gateArtifact is required but file doesn't exist", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{
				id: "phase-1",
				name: "Work",
				tasks: [{ id: "task-1", content: "Build feature", status: "pending", gateArtifact: "dist/output.json" }],
			},
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		mockRunSubprocess(transcriptPath, {
			extractedToolData: { bash: [{ command: "bun build", exitCode: 0 }] },
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
		expect(finalTask?.delegation?.result?.gateFailures?.[0]?.gate).toBe("gateArtifact");
	});

	it("marks todo completed when gateArtifact exists", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		// Create the artifact file
		const artifactDir = path.join(tempDir, "dist");
		await fs.mkdir(artifactDir, { recursive: true });
		await fs.writeFile(path.join(artifactDir, "output.json"), "{}");

		const session = createSession(tempDir, settings, [
			{
				id: "phase-1",
				name: "Work",
				tasks: [{ id: "task-1", content: "Build feature", status: "pending", gateArtifact: "dist/output.json" }],
			},
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		mockRunSubprocess(transcriptPath);

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
	});

	it("reports multiple gate failures when multiple gates fail", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{
				id: "phase-1",
				name: "Work",
				tasks: [
					{
						id: "task-1",
						content: "Build feature",
						status: "pending",
						gateCmd: "bun test",
						gateCommit: true,
					},
				],
			},
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		// Subagent ran bun test (satisfies gateCmd) but never committed (fails gateCommit)
		mockRunSubprocess(transcriptPath, {
			extractedToolData: { bash: [{ command: "bun check", exitCode: 0 }] },
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
		const failures = finalTask?.delegation?.result?.gateFailures ?? [];
		expect(failures.length).toBe(2);
		const gates = failures.map(f => f.gate).sort();
		expect(gates).toEqual(["gateCmd", "gateCommit"]);
	});

	it("marks todo failed when subagent fails (exitCode != 0), does NOT check gates", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{
				id: "phase-1",
				name: "Work",
				tasks: [{ id: "task-1", content: "Build feature", status: "pending", gateCmd: "bun test" }],
			},
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		// Subagent fails
		mockRunSubprocess(transcriptPath, {
			exitCode: 1,
			error: "crashed",
			stderr: "boom",
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
		// Should be "failed", NOT "gate_failed"
		expect(finalTask?.status).toBe("failed");
		// No gate failures should be present
		expect(finalTask?.delegation?.result?.gateFailures).toBeUndefined();
	});

	it("marks todo gate_failed when extractedToolData is empty (no bash history)", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{
				id: "phase-1",
				name: "Work",
				tasks: [{ id: "task-1", content: "Build feature", status: "pending", gateCmd: "bun test" }],
			},
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		// No extractedToolData at all
		mockRunSubprocess(transcriptPath, {
			extractedToolData: undefined,
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
	});

	it("marks todo completed when gateCmd passes and gateCommit passes", async () => {
		const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
		const session = createSession(tempDir, settings, [
			{
				id: "phase-1",
				name: "Work",
				tasks: [
					{
						id: "task-1",
						content: "Build feature",
						status: "pending",
						gateCmd: "bun test",
						gateCommit: true,
					},
				],
			},
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "sub1.jsonl");
		mockRunSubprocess(transcriptPath, {
			extractedToolData: {
				bash: [
					{ command: "bun test", exitCode: 0 },
					{ command: "git commit -m 'done'", exitCode: 0 },
				],
			},
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
	});
});
