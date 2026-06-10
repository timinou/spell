import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, AgentProgress, SingleResult, TaskToolDetails } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { AwaitTool } from "../../src/tools/await-tool";

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

function createSession(tempDir: string, settings: Settings): ToolSession & { asyncJobManager: AsyncJobManager } {
	const asyncJobManager = new AsyncJobManager({
		onJobComplete: async () => {},
	});
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => path.join(tempDir, "session.jsonl"),
		getSessionSpawns: () => "*",
		getCompactContext: () => undefined,
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
		asyncJobManager,
	} as unknown as ToolSession & { asyncJobManager: AsyncJobManager };
}

describe("TaskTool async retry progress", () => {
	let tempDir: string;
	let session: (ToolSession & { asyncJobManager: AsyncJobManager }) | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-async-progress-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.asyncJobManager.dispose({ timeoutMs: 1_000 });
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("forwards child retry progress to async updates and await output", async () => {
		const settings = Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "none",
			"task.maxConcurrency": 1,
		});
		session = createSession(tempDir, settings);
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
				durationMs: 25,
				retry: {
					attempt: 1,
					maxAttempts: 3,
					delayMs: 1_800_000,
					errorMessage: "usage limit reached",
				},
				sessionId: "child-session",
				transcriptPath,
			};
			options.onProgress?.(progress);
			await Bun.sleep(50);
			return createResult(options.id, transcriptPath);
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);
		const updates: TaskToolDetails[] = [];
		const startResult = await tool.execute(
			"call-async-progress",
			{
				agent: "task",
				tasks: [{ id: "subtask1", description: "Inspect file", assignment: "## Target\n- File: foo.ts", ref: null }],
			},
			undefined,
			update => {
				if (update.details) {
					updates.push(structuredClone(update.details));
				}
			},
		);
		const jobId = startResult.details?.async?.jobId;
		expect(jobId).toBeDefined();

		const retrySeen = async (): Promise<boolean> => {
			const deadline = Date.now() + 500;
			while (Date.now() < deadline) {
				if (updates.some(update => update.progress?.[0]?.retry?.errorMessage === "usage limit reached")) {
					return true;
				}
				await Bun.sleep(5);
			}
			return false;
		};
		expect(await retrySeen()).toBe(true);

		const awaitTool = new AwaitTool(session);
		const abortController = new AbortController();
		void Bun.sleep(5).then(() => abortController.abort("stop waiting"));
		const awaitResult = await awaitTool.execute("await-running-task", { jobs: [jobId!] }, abortController.signal);
		const awaitText = awaitResult.content.find(part => part.type === "text")?.text ?? "";
		expect(awaitText).toContain("Retrying (1/3)");
		expect(awaitText).toContain("usage limit reached");

		await session.asyncJobManager.waitForAll();
	});

	it("does not double-count scheduling failures in completion text", async () => {
		const settings = Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "none",
			"task.maxConcurrency": 3,
			"todo.enabled": false,
		});
		session = createSession(tempDir, settings);

		let callCount = 0;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			callCount += 1;
			if (callCount === 1) {
				await Bun.sleep(30);
				return createResult(options.id, path.join(tempDir, "artifacts", `${options.id}.jsonl`));
			}
			throw new Error("register failed");
		});

		const originalRegister = session.asyncJobManager.register.bind(session.asyncJobManager);
		let registerCount = 0;
		vi.spyOn(session.asyncJobManager, "register").mockImplementation((type, label, run, options) => {
			registerCount += 1;
			if (registerCount === 2) {
				throw new Error("registration failed");
			}
			return originalRegister(type, label, run, options);
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);
		const updates: { text: string }[] = [];
		await tool.execute(
			"call-double-count",
			{
				agent: "task",
				tasks: [
					{ id: "t1", description: "Task 1", assignment: "## Target\n- Task: 1", ref: null },
					{ id: "t2", description: "Task 2", assignment: "## Target\n- Task: 2", ref: null },
				],
			},
			undefined,
			update => {
				const text = update.content?.find(part => part.type === "text")?.text;
				if (text) updates.push({ text });
			},
		);

		await session.asyncJobManager.waitForAll();

		const completionUpdate = updates.find(update => update.text.includes("Background task batch complete"));
		expect(completionUpdate?.text).toContain("1 failed");
		expect(completionUpdate?.text).not.toContain("2 failed");
	});
});
