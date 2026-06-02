import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getCompactContext: () => undefined,
		getPlanModeState: () => undefined,
		getActiveModelString: () => undefined,
		getModelString: () => undefined,
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getSessionId: () => "scope-session",
		settings: Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" }),
		agentOutputManager: { allocateBatch: async (ids: string[]) => ids },
		authStorage: {} as never,
		modelRegistry: { refresh: async () => {} } as never,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
	} as unknown as ToolSession;
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

describe("TaskTool explicit filesDeps outside session cwd", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-outside-session-cwd-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("dispatches upward-relative sibling-package targets without re-rooting session cwd", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const sessionCwd = path.join(repoRoot, "apps", "agentmaker");
		const siblingTarget = path.join(repoRoot, "packages", "djinn", "src", "fixture.ts");
		const relativeTarget = path.relative(sessionCwd, siblingTarget);
		await fs.mkdir(path.dirname(siblingTarget), { recursive: true });

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [quickTaskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			expect(options.cwd).toBe(sessionCwd);
			expect(options.filesDeps).toEqual([relativeTarget]);
			return createResult(options.id, options.description ?? "task");
		});
		const { TaskTool } = await import("../../src/task/index");
		const session = createSession(sessionCwd);
		const tool = await TaskTool.create(session);

		const result = await tool.execute(
			"sibling-package-target",
			buildParams([{ id: "sibling-relative", filesDeps: [relativeTarget] }]),
		);
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(text).toContain("sibling-relative");
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(session.cwd).toBe(sessionCwd);
	});

	it("passes absolute sibling-package targets through without scope preflight aborts", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const sessionCwd = path.join(repoRoot, "apps", "agentmaker");
		const siblingTarget = path.join(repoRoot, "packages", "djinn", "src", "absolute.ts");
		await fs.mkdir(path.dirname(siblingTarget), { recursive: true });

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [quickTaskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			expect(options.cwd).toBe(sessionCwd);
			expect(options.filesDeps).toEqual([siblingTarget]);
			return createResult(options.id, options.description ?? "task");
		});
		const { TaskTool } = await import("../../src/task/index");
		const session = createSession(sessionCwd);
		const tool = await TaskTool.create(session);

		const result = await tool.execute(
			"absolute-sibling-package-target",
			buildParams([{ id: "sibling-absolute", filesDeps: [siblingTarget] }]),
		);
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(text).toContain("sibling-absolute");
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(session.cwd).toBe(sessionCwd);
	});
});
