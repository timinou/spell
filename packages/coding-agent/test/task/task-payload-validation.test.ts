import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const MAX_TASK_PAYLOAD_BYTES = 50 * 1024;

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

function createSession(tempDir: string, settings: Settings): ToolSession {
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
	} as unknown as ToolSession;
}

function payloadBytes(params: TaskParams): number {
	return Buffer.byteLength(JSON.stringify(params), "utf-8");
}

function createParamsAtByteSize(targetBytes: number): TaskParams {
	const params: TaskParams = {
		agent: "task",
		tasks: [{ id: "task-a", description: "A", assignment: "", ref: null }],
	};
	const task = params.tasks[0]!;
	const baseBytes = payloadBytes(params);
	if (baseBytes > targetBytes) {
		throw new Error(`Base payload ${baseBytes} already exceeds target ${targetBytes}`);
	}
	task.assignment = "a".repeat(targetBytes - baseBytes);
	while (payloadBytes(params) > targetBytes) {
		task.assignment = task.assignment.slice(0, -1);
	}
	while (payloadBytes(params) < targetBytes) {
		task.assignment += "a";
	}
	return params;
}

function createParamsOverLimitByBytes(limitBytes: number): TaskParams {
	const params: TaskParams = {
		agent: "task",
		tasks: [{ id: "task-b", description: "B", assignment: "", ref: null }],
	};
	const task = params.tasks[0]!;
	const fillUnit = "é";
	const fillUnitBytes = Buffer.byteLength(fillUnit, "utf-8");
	const baseBytes = payloadBytes(params);
	const shortfall = Math.max(1, limitBytes + 1 - baseBytes);
	task.assignment = fillUnit.repeat(Math.ceil(shortfall / fillUnitBytes));
	while (payloadBytes(params) <= limitBytes) {
		task.assignment += fillUnit;
	}
	return params;
}

describe("TaskTool payload validation", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-payload-validation-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("executes tasks when payload stays below the 50KB byte limit", async () => {
		const params = createParamsAtByteSize(MAX_TASK_PAYLOAD_BYTES - 1);
		expect(payloadBytes(params)).toBe(MAX_TASK_PAYLOAD_BYTES - 1);
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("task-a", "A"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(tempDir, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })),
		);

		const result = await tool.execute("call-under-limit", params);
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(text.startsWith("Invalid tasks:")).toBe(false);
	});

	it("rejects payloads over the 50KB byte limit before execution", async () => {
		const params = createParamsOverLimitByBytes(MAX_TASK_PAYLOAD_BYTES);
		const serialized = JSON.stringify(params);
		expect(serialized.length).toBeLessThan(MAX_TASK_PAYLOAD_BYTES);
		expect(Buffer.byteLength(serialized, "utf-8")).toBeGreaterThan(MAX_TASK_PAYLOAD_BYTES);
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("task-b", "B"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(
			createSession(tempDir, Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" })),
		);

		const result = await tool.execute("call-over-limit", params);
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(runSpy).not.toHaveBeenCalled();
		expect(text).toContain("Invalid tasks: Task payload size");
		expect(text).toContain("exceeds");
		expect(text).toContain("Keep assignments lean and move shared context out of per-task payloads.");
	});
});
