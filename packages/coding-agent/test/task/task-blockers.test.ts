import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
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

function createSession(
	tempDir: string,
	settings: Settings,
	asyncJobManager?: AsyncJobManager,
): ToolSession & { asyncJobManager?: AsyncJobManager } {
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
		asyncJobManager,
	} as unknown as ToolSession & { asyncJobManager?: AsyncJobManager };
}

describe("TaskTool blocker integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-blockers-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("sync execution respects blocker order", async () => {
		const events: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			events.push(`start:${options.description}`);
			await Bun.sleep(options.description === "A" ? 5 : 1);
			events.push(`end:${options.description}`);
			return createResult(options.id, options.description ?? "task");
		});

		const tool = await TaskTool.create(
			createSession(tempDir, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })),
		);
		await tool.execute("call-sync-blockers", {
			agent: "task",
			tasks: [
				{ id: "A", description: "A", assignment: "## Target\n- Task: A" },
				{ id: "B", description: "B", assignment: "## Target\n- Task: B", blockers: ["A"] },
				{ id: "C", description: "C", assignment: "## Target\n- Task: C", blockers: ["A"] },
			],
		});

		expect(events.indexOf("end:A")).toBeLessThan(events.indexOf("start:B"));
		expect(events.indexOf("end:A")).toBeLessThan(events.indexOf("start:C"));
	});

	it("async execution schedules dependents only after predecessors finish", async () => {
		const events: string[] = [];
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async () => {},
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			events.push(`start:${options.description}`);
			await Bun.sleep(5);
			events.push(`end:${options.description}`);
			return createResult(options.id, options.description ?? "task");
		});

		const tool = await TaskTool.create(
			createSession(
				tempDir,
				Settings.isolated({ "async.enabled": true, "task.isolation.mode": "none", "task.maxConcurrency": 2 }),
				asyncJobManager,
			),
		);
		await tool.execute("call-async-blockers", {
			agent: "task",
			tasks: [
				{ id: "A", description: "A", assignment: "## Target\n- Task: A" },
				{ id: "B", description: "B", assignment: "## Target\n- Task: B", blockers: ["A"] },
				{ id: "C", description: "C", assignment: "## Target\n- Task: C", blockers: ["B"] },
			],
		});
		const deadline = Date.now() + 500;
		while (events.length < 6 && Date.now() < deadline) {
			await Bun.sleep(10);
		}
		await asyncJobManager.dispose({ timeoutMs: 1_000 });

		expect(events).toEqual(["start:A", "end:A", "start:B", "end:B", "start:C", "end:C"]);
	});
});
