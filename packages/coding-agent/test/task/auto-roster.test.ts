import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
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

function createResult(
	id: string,
	description: string,
	transcriptPath: string,
	overrides: Partial<SingleResult> = {},
): SingleResult {
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
		sessionId: "child-session",
		transcriptPath,
		...overrides,
	};
}

function createSession(
	tempDir: string,
	settings: Settings,
	initialGroups: TodoGroup[] = [],
): ToolSession & { snapshots: TodoGroup[][]; getCurrentGroups: () => TodoGroup[] } {
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
		getCurrentGroups: () => groups,
	} as unknown as ToolSession & { snapshots: TodoGroup[][]; getCurrentGroups: () => TodoGroup[] };
}

describe("TaskTool auto-roster", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-auto-roster-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("auto-creates pending delegated todo entries before execution starts", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-auto-roster", {
			agent: "task",
			tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target\n- Task: Inspect" }],
		});

		const createdSnapshot = session.snapshots[0];
		expect(createdSnapshot?.[0]?.name).toBe("Tasks");
		expect(createdSnapshot?.[0]?.tasks[0]).toMatchObject({
			content: "Inspect",
			status: "pending",
			delegation: { sessionId: "pending", agent: "task" },
		});
	});

	it("sanitizes literal newline inputs before creating auto-roster entries", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
		const heading =
			"Investigate auto roster sanitization integration with literal newline inputs across task dispatch";
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Verify stuff", transcriptPath));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-sanitize-integration", {
			agent: "task",
			context: `## ${heading}\\n## Goal\\nFix dispatch`,
			tasks: [{ id: "verify", description: "Verify\\nstuff", assignment: "## Target\n- Task: Verify" }],
		});

		const createdPhase = session.snapshots[0]?.[0];
		expect(createdPhase?.name).toBe(heading.slice(0, 80));
		expect(createdPhase?.name).toHaveLength(80);
		expect(createdPhase?.tasks[0]?.content).toBe("Verify stuff");
	});

	it("marks auto-created tasks in_progress and completed with delegated metadata", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
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
			return createResult(options.id, options.description ?? "task", transcriptPath);
		});
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-auto-roster-running", {
			agent: "task",
			tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target\n- Task: Inspect" }],
		});

		const runningSnapshot = session.snapshots.find(snapshot => snapshot[0]?.tasks[0]?.status === "in_progress");
		expect(runningSnapshot?.[0]?.tasks[0]).toMatchObject({
			status: "in_progress",
			delegation: {
				agent: "task",
				sessionId: "child-session",
				transcriptPath,
			},
		});
		expect(session.getCurrentGroups()[0]?.tasks[0]).toMatchObject({
			status: "completed",
			delegation: {
				agent: "task",
				sessionId: "child-session",
				transcriptPath,
			},
		});
	});

	it("preserves existing todoRef entries and only auto-creates missing tasks", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings, [
			{ id: "phase-1", name: "Existing", tasks: [{ id: "task-1", content: "Existing", status: "pending" }] },
		]);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Existing", transcriptPath));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-mixed-roster", {
			agent: "task",
			tasks: [
				{ id: "existing", description: "Existing", assignment: "## Target\n- Task: Existing", todoRef: "task-1" },
				{ id: "new-task", description: "New task", assignment: "## Target\n- Task: New task" },
			],
		});

		const groups = session.getCurrentGroups();
		expect(groups).toHaveLength(2);
		expect(groups[0]?.tasks[0]?.id).toBe("task-1");
		expect(groups[1]?.tasks).toHaveLength(1);
		expect(groups[1]?.tasks[0]).toMatchObject({ content: "New task" });
	});

	it("uses the provided phase name for auto-created work", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-phase-roster", {
			agent: "task",
			phase: "Investigation",
			tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target\n- Task: Inspect" }],
		});

		expect(session.snapshots[0]?.[0]?.name).toBe("Investigation");
	});

	it("suppresses auto-roster when agent roster is disabled or setting is off", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ ...baseAgent, name: "quick_task", roster: false }],
			projectAgentsDir: null,
		});
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
		const { TaskTool } = await import("../../src/task/index");

		const rosterSuppressed = createSession(
			tempDir,
			Settings.isolated({
				"async.enabled": false,
				"task.isolation.mode": "none",
				"todo.enabled": true,
				"task.autoRoster": true,
			}),
		);
		await (await TaskTool.create(rosterSuppressed)).execute("call-roster-false", {
			agent: "quick_task",
			tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target\n- Task: Inspect" }],
		});
		expect(rosterSuppressed.getCurrentGroups()).toEqual([]);

		const settingSuppressed = createSession(
			tempDir,
			Settings.isolated({
				"async.enabled": false,
				"task.isolation.mode": "none",
				"todo.enabled": true,
				"task.autoRoster": false,
			}),
		);
		await (await TaskTool.create(settingSuppressed)).execute("call-auto-roster-off", {
			agent: "quick_task",
			tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target\n- Task: Inspect" }],
		});
		expect(settingSuppressed.getCurrentGroups()).toEqual([]);
	});

	it("marks auto-created tasks failed on abort without leaving pending items", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.maxConcurrency": 1,
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const controller = new AbortController();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
			return new Promise<SingleResult>((_, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		});
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);
		void Bun.sleep(10).then(() => controller.abort("stop"));

		await tool.execute(
			"call-auto-roster-abort",
			{
				agent: "task",
				tasks: [
					{ id: "a", description: "A", assignment: "## Target\n- Task: A" },
					{ id: "b", description: "B", assignment: "## Target\n- Task: B", blockers: ["a"] },
				],
			},
			controller.signal,
		);

		const finalTasks = session.getCurrentGroups()[0]?.tasks ?? [];
		expect(finalTasks.map(task => task.status)).toEqual(["failed", "failed"]);
		expect(finalTasks.some(task => task.status === "pending")).toBe(false);
	});

	it("abort sets delegation sessionId to skipped, not pending", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.maxConcurrency": 1,
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const controller = new AbortController();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
			return new Promise<SingleResult>((_, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		});
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);
		void Bun.sleep(10).then(() => controller.abort("stop"));

		await tool.execute(
			"call-abort-sessionid",
			{
				agent: "task",
				tasks: [
					{ id: "a", description: "A", assignment: "## Target\n- Task: A" },
					{ id: "b", description: "B", assignment: "## Target\n- Task: B", blockers: ["a"] },
				],
			},
			controller.signal,
		);

		const finalTasks = session.getCurrentGroups()[0]?.tasks ?? [];
		for (const task of finalTasks) {
			expect(task.delegation?.sessionId).not.toBe("pending");
			expect(task.delegation?.sessionId).toBe("skipped");
		}
	});

	it("failed task delegation includes error in result", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.maxConcurrency": 1,
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const controller = new AbortController();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
			return new Promise<SingleResult>((_, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		});
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);
		void Bun.sleep(10).then(() => controller.abort("immediate"));

		await tool.execute(
			"call-abort-result",
			{
				agent: "task",
				tasks: [
					{ id: "a", description: "A", assignment: "## Target\n- Task: A" },
					{ id: "b", description: "B", assignment: "## Target\n- Task: B", blockers: ["a"] },
				],
			},
			controller.signal,
		);

		const finalTasks = session.getCurrentGroups()[0]?.tasks ?? [];
		expect(finalTasks[0]?.delegation?.result?.error).toBeDefined();
		expect(finalTasks[1]?.delegation?.result?.error).toBeDefined();
	});

	it("suppresses auto-roster when todos are disabled", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"todo.enabled": false,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-todos-disabled", {
			agent: "task",
			tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target\n- Task: Inspect" }],
		});

		expect(session.getCurrentGroups()).toEqual([]);
	});

	it("returns error without orphan items when async enabled but no manager", async () => {
		const settings = Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "none",
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		const result = await tool.execute("call-async-no-manager", {
			agent: "task",
			tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target\n- Task: Inspect" }],
		});

		const text = result.content.find(p => p.type === "text")?.text ?? "";
		expect(text).toContain("no async job manager");
		expect(session.getCurrentGroups()).toEqual([]);
	});

	it("sync path still auto-creates roster items after guard", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-sync-auto-roster", {
			agent: "task",
			tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target\n- Task: Inspect" }],
		});

		expect(session.snapshots.length).toBeGreaterThan(0);
		expect(session.snapshots[0]?.[0]?.tasks[0]).toMatchObject({ content: "Inspect" });
	});

	it("async + blocking agent still creates roster items", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ ...baseAgent, blocking: true }],
			projectAgentsDir: null,
		});
		const settings = Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "none",
			"todo.enabled": true,
			"task.autoRoster": true,
		});
		const session = createSession(tempDir, settings);
		const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		await tool.execute("call-async-blocking", {
			agent: "task",
			tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target\n- Task: Inspect" }],
		});

		expect(session.snapshots.length).toBeGreaterThan(0);
		expect(session.snapshots[0]?.[0]?.tasks[0]).toMatchObject({ content: "Inspect" });
	});

	describe("phase name derivation", () => {
		it("skips structural heading Goal and falls back to Tasks", async () => {
			const settings = Settings.isolated({
				"async.enabled": false,
				"task.isolation.mode": "none",
				"todo.enabled": true,
				"task.autoRoster": true,
			});
			const session = createSession(tempDir, settings);
			const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
			const { TaskTool } = await import("../../src/task/index");
			const tool = await TaskTool.create(session);

			await tool.execute("call-phase-goal", {
				agent: "task",
				context: "## Goal\nRename symbols",
				tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target" }],
			});

			expect(session.snapshots[0]?.[0]?.name).toBe("Tasks");
		});

		it("uses first non-structural heading", async () => {
			const settings = Settings.isolated({
				"async.enabled": false,
				"task.isolation.mode": "none",
				"todo.enabled": true,
				"task.autoRoster": true,
			});
			const session = createSession(tempDir, settings);
			const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
			const { TaskTool } = await import("../../src/task/index");
			const tool = await TaskTool.create(session);

			await tool.execute("call-phase-investigation", {
				agent: "task",
				context: "# Investigation\n## Goal\nRename symbols",
				tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target" }],
			});

			expect(session.snapshots[0]?.[0]?.name).toBe("Investigation");
		});

		it("falls back to Tasks when all headings are structural", async () => {
			const settings = Settings.isolated({
				"async.enabled": false,
				"task.isolation.mode": "none",
				"todo.enabled": true,
				"task.autoRoster": true,
			});
			const session = createSession(tempDir, settings);
			const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
			const { TaskTool } = await import("../../src/task/index");
			const tool = await TaskTool.create(session);

			await tool.execute("call-phase-all-structural", {
				agent: "task",
				context: "## Goal\n## Constraints\n## Acceptance",
				tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target" }],
			});

			expect(session.snapshots[0]?.[0]?.name).toBe("Tasks");
		});

		it("does not skip headings that contain skip-list word as prefix", async () => {
			const settings = Settings.isolated({
				"async.enabled": false,
				"task.isolation.mode": "none",
				"todo.enabled": true,
				"task.autoRoster": true,
			});
			const session = createSession(tempDir, settings);
			const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
			const { TaskTool } = await import("../../src/task/index");
			const tool = await TaskTool.create(session);

			await tool.execute("call-phase-goals-prefix", {
				agent: "task",
				context: "## Goals for Sprint 3\nSome content",
				tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target" }],
			});

			expect(session.snapshots[0]?.[0]?.name).toBe("Goals for Sprint 3");
		});

		it("skips Non-goals and API Contract headings", async () => {
			const settings = Settings.isolated({
				"async.enabled": false,
				"task.isolation.mode": "none",
				"todo.enabled": true,
				"task.autoRoster": true,
			});
			const session = createSession(tempDir, settings);
			const transcriptPath = path.join(tempDir, "artifacts", "subtask.jsonl");
			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("one", "Inspect", transcriptPath));
			const { TaskTool } = await import("../../src/task/index");
			const tool = await TaskTool.create(session);

			await tool.execute("call-phase-nogoals", {
				agent: "task",
				context: "## Non-goals\nDon't change tests\n## API Contract\nExact types",
				tasks: [{ id: "inspect", description: "Inspect", assignment: "## Target" }],
			});

			expect(session.snapshots[0]?.[0]?.name).toBe("Tasks");
		});
	});
});
