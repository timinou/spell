import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";

import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult, TaskToolDetails } from "../../src/task/types";
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

		const { TaskTool } = await import("../../src/task/index");
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

		const { TaskTool } = await import("../../src/task/index");
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
		const deadline = Date.now() + 5_000;
		while (events.length < 6 && Date.now() < deadline) {
			await Bun.sleep(25);
		}
		await asyncJobManager.dispose({ timeoutMs: 1_000 });

		expect(events).toEqual(["start:A", "end:A", "start:B", "end:B", "start:C", "end:C"]);
	});

	it("sync execution reports implicit blockers in text and details", async () => {
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			createResult(options.id, options.description ?? "task"),
		);
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(tempDir, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })),
		);
		const result = await tool.execute("call-sync-implicit-blockers", {
			agent: "task",
			tasks: [
				{ id: "A", description: "A", assignment: "## Target\n- Task: A", filesDeps: ["src/"] },
				{ id: "B", description: "B", assignment: "## Target\n- Task: B", filesDeps: ["src/foo.ts"] },
			],
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		const details = result.details as TaskToolDetails;

		expect(text).toContain("Note: reorganized 2 tasks into dependency chains due to filesDeps overlap.");
		expect(text).toContain("B<-A (src/foo.ts)");
		expect(details.implicit_blockers).toEqual([{ to: "B", from: "A", reason: path.join(tempDir, "src", "foo.ts") }]);
	});

	it("async execution reports implicit blockers in text and details", async () => {
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async () => {},
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await Bun.sleep(5);
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
		const result = await tool.execute("call-async-implicit-blockers", {
			agent: "task",
			tasks: [
				{ id: "A", description: "A", assignment: "## Target\n- Task: A", filesDeps: ["src/"] },
				{ id: "B", description: "B", assignment: "## Target\n- Task: B", filesDeps: ["src/foo.ts"] },
			],
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		const details = result.details as TaskToolDetails;

		expect(text).toContain("Note: reorganized 2 tasks into dependency chains due to filesDeps overlap.");
		expect(text).toContain("B<-A (src/foo.ts)");
		expect(details.implicit_blockers).toEqual([{ to: "B", from: "A", reason: path.join(tempDir, "src", "foo.ts") }]);

		await asyncJobManager.dispose({ timeoutMs: 1_000 });
	});
	it("Scenario C: dispatch text enumerates queued tasks with explicit blocker chain", async () => {
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async () => {},
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await Bun.sleep(5);
			return createResult(options.id, options.description ?? "task");
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(
				tempDir,
				Settings.isolated({
					"async.enabled": true,
					"task.isolation.mode": "none",
					"task.maxConcurrency": 4,
					"todo.enabled": false,
				}),
				asyncJobManager,
			),
		);
		const result = await tool.execute("call-queued-text", {
			agent: "task",
			tasks: [
				{ id: "X", description: "X", assignment: "## Target\\n- Task: X" },
				{ id: "Y", description: "Y", assignment: "## Target\\n- Task: Y" },
				{ id: "Z", description: "Z", assignment: "## Target\\n- Task: Z", blockers: ["X"] },
			],
		});

		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Started 2 background task jobs");
		expect(text).toContain("1 queued");
		expect(text).toContain("Z<-X");

		await asyncJobManager.dispose({ timeoutMs: 1_000 });
	});

	it("Scenario D: dispatch text mentions queued for implicit-only blockers", async () => {
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async () => {},
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await Bun.sleep(5);
			return createResult(options.id, options.description ?? "task");
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(
				tempDir,
				Settings.isolated({
					"async.enabled": true,
					"task.isolation.mode": "none",
					"task.maxConcurrency": 4,
					"todo.enabled": false,
				}),
				asyncJobManager,
			),
		);
		const result = await tool.execute("call-implicit-queued", {
			agent: "task",
			tasks: [
				{ id: "P", description: "P", assignment: "## Target\\n- Task: P", filesDeps: ["a.ts"] },
				{ id: "Q", description: "Q", assignment: "## Target\\n- Task: Q", filesDeps: ["a.ts"] },
			],
		});

		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("1 queued");
		expect(text).toContain("Q<-P");

		await asyncJobManager.dispose({ timeoutMs: 1_000 });
	});

	it("Scenario E: dispatch text omits queued mention when no blockers", async () => {
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async () => {},
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await Bun.sleep(5);
			return createResult(options.id, options.description ?? "task");
		});

		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(
				tempDir,
				Settings.isolated({
					"async.enabled": true,
					"task.isolation.mode": "none",
					"task.maxConcurrency": 4,
					"todo.enabled": false,
				}),
				asyncJobManager,
			),
		);
		const result = await tool.execute("call-no-blockers-no-queued", {
			agent: "task",
			tasks: [
				{ id: "M", description: "M", assignment: "## Target\\n- Task: M" },
				{ id: "N", description: "N", assignment: "## Target\\n- Task: N" },
			],
		});

		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).not.toContain("queued");
		// guard: should still mention started count
		expect(text).toContain("Started 2");

		await asyncJobManager.dispose({ timeoutMs: 1_000 });
	});
});
