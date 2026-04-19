import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { parseAgentFields } from "../../src/discovery/helpers";
import { clearBundledAgentsCache, loadBundledAgents } from "../../src/task/agents";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import { buildScopeRestrictedSandboxPolicy } from "../../src/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { WriteTool } from "../../src/tools/write";

const quickTaskAgent: AgentDefinition = {
	name: "quick_task",
	description: "test quick task",
	systemPrompt: "Quick",
	tools: ["read", "grep", "find", "edit", "write", "bash"],
	source: "bundled",
	scopeRestricted: true,
};

const fullTaskAgent: AgentDefinition = {
	name: "task",
	description: "test task",
	systemPrompt: "Task",
	tools: ["read"],
	spawns: ["task"],
	source: "bundled",
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
		output: description,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
	};
}

function createSession(tempDir: string): ToolSession {
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

function buildParams(agent: string, taskDefs: Array<{ id: string; filesDeps?: string[] }>): TaskParams {
	return {
		agent,
		tasks: taskDefs.map(task => ({
			id: task.id,
			description: task.id,
			assignment: `## Target\n- Task: ${task.id}`,
			...(task.filesDeps ? { filesDeps: task.filesDeps } : {}),
		})),
	} as TaskParams;
}

describe("quick_task scope guardrails", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quick-task-scope-"));
		await fs.mkdir(path.join(tempDir, "artifacts"), { recursive: true });
	});

	afterEach(async () => {
		clearBundledAgentsCache();
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("bundled quick_task is not scopeRestricted by default", () => {
		const agents = loadBundledAgents();
		const scoped = agents.filter(agent => agent.scopeRestricted === true).map(agent => agent.name);
		expect(scoped).not.toContain("quick_task");
	});

	it("parseAgentFields preserves explicit scopeRestricted flag", () => {
		const parsed = parseAgentFields({ name: "demo", description: "demo", scopeRestricted: true });
		expect(parsed?.scopeRestricted).toBe(true);
	});

	it("rejects quick_task dispatch when filesDeps is missing", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [quickTaskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("scoped", "scoped"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir));

		const result = await tool.execute("scope-missing", buildParams("quick_task", [{ id: "scoped" }]));
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(text).toContain("QUICK_TASK_MISSING_FILESDEPS");
		expect(text).toContain("scoped");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("rejects quick_task dispatch when filesDeps is empty", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [quickTaskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("scoped", "scoped"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir));

		const result = await tool.execute("scope-empty", buildParams("quick_task", [{ id: "scoped", filesDeps: [] }]));
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(text).toContain("QUICK_TASK_MISSING_FILESDEPS");
		expect(text).toContain("scoped");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("builds a scope-restricted sandbox policy with rebased allowed paths", () => {
		const parentCwd = path.join(tempDir, "repo");
		const sessionCwd = path.join(tempDir, "repo-worktree");
		const policy = buildScopeRestrictedSandboxPolicy({
			parentCwd,
			sessionCwd,
			filesDeps: [path.join(parentCwd, "src", "foo.ts"), `${path.join(parentCwd, "packages", "natives", "test")}/`],
		});

		expect(policy).toEqual({
			pathsWrite: [
				path.join(sessionCwd, "src", "foo.ts"),
				`${path.join(sessionCwd, "packages", "natives", "test")}${path.sep}`,
			],
			bashAllow: [],
			bashDeny: [],
			writeErrorPrefix: "OUT_OF_SCOPE_MUTATION: ",
		});
	});

	it("blocks out-of-scope writes with OUT_OF_SCOPE_MUTATION", async () => {
		const scopedFile = path.join(tempDir, "src", "foo.ts");
		const otherFile = path.join(tempDir, "src", "bar.ts");
		await fs.mkdir(path.dirname(scopedFile), { recursive: true });

		const policy = buildScopeRestrictedSandboxPolicy({
			parentCwd: tempDir,
			sessionCwd: tempDir,
			filesDeps: [scopedFile],
		});
		const tool = new WriteTool({ ...createSession(tempDir), sandboxPolicy: policy } as never);

		await expect(
			tool.execute("scope-write", { path: otherFile, content: "export const bar = 1;\n" } as never),
		).rejects.toThrow("OUT_OF_SCOPE_MUTATION");
	});

	it("allows in-scope writes for quick_task sandbox policy", async () => {
		const scopedFile = path.join(tempDir, "src", "foo.ts");
		await fs.mkdir(path.dirname(scopedFile), { recursive: true });

		const policy = buildScopeRestrictedSandboxPolicy({
			parentCwd: tempDir,
			sessionCwd: tempDir,
			filesDeps: [scopedFile],
		});
		const tool = new WriteTool({ ...createSession(tempDir), sandboxPolicy: policy } as never);

		const result = await tool.execute("scope-write-ok", {
			path: scopedFile,
			content: "export const foo = 1;\n",
		} as never);
		const text = result.content.find(part => part.type === "text")?.text ?? "";

		expect(text).toContain("Successfully wrote");
	});

	it("does not restrict the full task agent", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [fullTaskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(createResult("full", "full"));
		const { TaskTool } = await import("../../src/task/index");
		const tool = await TaskTool.create(createSession(tempDir));

		await tool.execute("scope-unrestricted", buildParams("task", [{ id: "full" }]));

		expect(runSpy).toHaveBeenCalledTimes(1);
	});
});
