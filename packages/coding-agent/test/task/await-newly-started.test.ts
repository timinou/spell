import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { AwaitTool } from "../../src/tools/await-tool";

import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";

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

describe("AwaitTool Newly Started detection", () => {
	let tempDir: string;
	let session: (ToolSession & { asyncJobManager: AsyncJobManager }) | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "await-newly-started-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.asyncJobManager.dispose({ timeoutMs: 1_000 });
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("Scenario A: renders Newly Started for auto-promoted blocker", async () => {
		const settings = Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "none",
			"task.maxConcurrency": 4,
			"todo.enabled": false,
		});
		session = createSession(tempDir, settings);

		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (options.id === "A") {
				await Bun.sleep(30);
			}
			return createResult(options.id, options.description ?? "task");
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		const startResult = await tool.execute("call-newly-started-test", {
			agent: "task",
			tasks: [
				{ id: "A", description: "A", assignment: "## Target\n- Task: A" },
				{ id: "B", description: "B", assignment: "## Target\n- Task: B", blockers: ["A"] },
			],
		});

		const jobIdA = startResult.details?.async?.jobId;
		expect(jobIdA).toBeDefined();

		const awaitInvocationTime = Date.now();
		const awaitTool = new AwaitTool(session);
		const awaitResult = await awaitTool.execute("await-after-A", { jobs: [jobIdA!] });

		const awaitText = awaitResult.content.find(part => part.type === "text")?.text ?? "";
		expect(awaitText).toContain("## Newly Started");

		const jobs = awaitResult.details?.jobs ?? [];
		expect(jobs.length).toBe(2);

		const completedA = jobs.find(job => job.label === "A");
		expect(completedA).toBeDefined();
		expect(completedA!.status).toBe("completed");

		const runningB = jobs.find(job => job.label === "B");
		expect(runningB).toBeDefined();
		expect(runningB!.status).toBe("running");
		expect(runningB!.durationMs).toBeGreaterThanOrEqual(0);

		// B must have been started after our await call
		const bJob = session.asyncJobManager.getJob(runningB!.id);
		expect(bJob).toBeDefined();
		expect(bJob!.startTime).toBeGreaterThanOrEqual(awaitInvocationTime);

		await session.asyncJobManager.waitForAll();
	});

	it("Scenario B: does not render Newly Started without auto-promotion", async () => {
		const settings = Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "none",
			"task.maxConcurrency": 4,
			"todo.enabled": false,
		});
		session = createSession(tempDir, settings);

		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await Bun.sleep(5);
			return createResult(options.id, options.description ?? "task");
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(session);

		const startResult = await tool.execute("call-no-newly-started", {
			agent: "task",
			tasks: [
				{ id: "C", description: "C", assignment: "## Target\n- Task: C" },
			],
		});

		const jobId = startResult.details?.async?.jobId;
		expect(jobId).toBeDefined();

		const awaitTool = new AwaitTool(session);
		const awaitResult = await awaitTool.execute("await-single", { jobs: [jobId!] });

		const awaitText = awaitResult.content.find(part => part.type === "text")?.text ?? "";
		expect(awaitText).not.toContain("## Newly Started");

		await session.asyncJobManager.waitForAll();
	});
});
