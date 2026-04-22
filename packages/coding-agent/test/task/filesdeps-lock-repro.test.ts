import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const quickTaskAgent: AgentDefinition = {
	name: "quick_task",
	description: "test quick task",
	systemPrompt: "Quick",
	tools: ["read", "grep", "find", "edit", "write", "bash"],
	source: "bundled",
	scopeRestricted: true,
};

function createResult(id: string, description: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "quick_task",
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

function createSession(
	tempDir: string,
	settings: Settings,
	asyncJobManager?: AsyncJobManager,
): ToolSession & { asyncJobManager?: AsyncJobManager } {
	return {
		cwd: tempDir,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(tempDir, "session.jsonl"),
		getSessionSpawns: () => "*",
		getCompactContext: () => undefined,
		getPlanModeState: () => undefined,
		getActiveModelString: () => undefined,
		getModelString: () => undefined,
		getArtifactsDir: () => path.join(tempDir, "artifacts"),
		getSessionId: () => "filesdeps-overlap-session",
		settings,
		agentOutputManager: { allocateBatch: async (ids: string[]) => ids },
		authStorage: {} as never,
		modelRegistry: { refresh: async () => {} } as never,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		asyncJobManager,
	} as unknown as ToolSession & { asyncJobManager?: AsyncJobManager };
}

function buildParams(taskDefs: Array<{ id: string; filesDeps: string[] }>): TaskParams {
	return {
		agent: "quick_task",
		tasks: taskDefs.map(task => ({
			id: task.id,
			description: task.id,
			assignment: `## Target\n- Task: ${task.id}`,
			filesDeps: task.filesDeps,
		})),
	} as TaskParams;
}

describe("quick_task filesDeps overlap scheduling", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "filesdeps-overlap-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [quickTaskAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("serializes sync quick_task siblings with identical filesDeps", async () => {
		const events: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			events.push(`start:${options.description}`);
			await Bun.sleep(20);
			events.push(`end:${options.description}`);
			return createResult(options.id, options.description ?? "task");
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(tempDir, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })),
		);
		await tool.execute(
			"filesdeps-sync-serial",
			buildParams([
				{ id: "A", filesDeps: ["src/foo.ts"] },
				{ id: "B", filesDeps: ["src/foo.ts"] },
			]),
		);

		expect(events).toEqual(["start:A", "end:A", "start:B", "end:B"]);
	});

	it("serializes async quick_task siblings with identical filesDeps", async () => {
		const events: string[] = [];
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async () => {},
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			events.push(`start:${options.description}`);
			await Bun.sleep(20);
			events.push(`end:${options.description}`);
			return createResult(options.id, options.description ?? "task");
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(
				tempDir,
				Settings.isolated({ "async.enabled": true, "task.isolation.mode": "none", "task.maxConcurrency": 2 }),
				asyncJobManager,
			),
		);
		await tool.execute(
			"filesdeps-async-serial",
			buildParams([
				{ id: "A", filesDeps: ["src/foo.ts"] },
				{ id: "B", filesDeps: ["src/foo.ts"] },
			]),
		);

		const deadline = Date.now() + 5_000;
		while (events.length < 4 && Date.now() < deadline) {
			await Bun.sleep(25);
		}
		await asyncJobManager.dispose({ timeoutMs: 1_000 });

		expect(events).toEqual(["start:A", "end:A", "start:B", "end:B"]);
	});
});
