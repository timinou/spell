import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@oh-my-pi/pi-coding-agent/tools";
import type { TaskPolicy } from "../../src/config/task-policies";
import {
	applyOps,
	type FormatSummaryOptions,
	fileFromPhases,
	formatSummary,
	injectPolicyGates,
	type TodoItem,
	type TodoStatus,
} from "../../src/tools/todo-write";

function makeTask(overrides: Partial<TodoItem> & { id: string; content: string }): TodoItem {
	return { status: "pending" as TodoStatus, ...overrides };
}

function makePhase(id: string, name: string, tasks: TodoItem[]): TodoPhase {
	return { id, name, tasks };
}

function createSession(cwd: string, initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

function summaryText(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find(entry => entry.type === "text");
	if (!part || part.type !== "text" || !part.text) throw new Error("Expected text summary from todo_write");
	return part.text;
}

function makeSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
	return formatSummary({
		phases: overrides.phases ?? [makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Do work" })])],
		errors: overrides.errors ?? [],
		completedPhaseIds: overrides.completedPhaseIds ?? [],
		completedGatedTasks: overrides.completedGatedTasks ?? [],
		pendingVerificationTasks: overrides.pendingVerificationTasks ?? [],
		pendingDeferralTasks: overrides.pendingDeferralTasks ?? [],
	});
}

const frontendPolicies: TaskPolicy[] = [
	{
		name: "frontend-defaults",
		match: { layer: "frontend" },
		gates: {
			gateCmd: "bun test packages/coding-agent/test/tools/todo-write-policies.test.ts",
			verifyCmd: "bun check packages/coding-agent/src/tools/todo-write.ts",
		},
	},
	{
		name: "frontend-commit",
		match: { layer: "frontend" },
		gates: { gateCommit: true },
	},
];

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "todo-write-policies-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("injectPolicyGates", () => {
	it("fills missing gates and preserves explicit gates", () => {
		const task = makeTask({
			id: "task-1",
			content: "Implement UI",
			layer: "frontend",
			gateCmd: "bun test explicit.test.ts",
		});

		injectPolicyGates(task, frontendPolicies);

		expect(task.gateCmd).toBe("bun test explicit.test.ts");
		expect(task.gateCommit).toBe(true);
		expect(task.verifyCmd).toBe("bun check packages/coding-agent/src/tools/todo-write.ts");
	});

	it("does nothing when layer is missing or unmatched", () => {
		const withoutLayer = makeTask({ id: "task-1", content: "A" });
		const unknownLayer = makeTask({ id: "task-2", content: "B", layer: "backend" });

		injectPolicyGates(withoutLayer, frontendPolicies);
		injectPolicyGates(unknownLayer, frontendPolicies);

		expect(withoutLayer.gateCommit).toBeUndefined();
		expect(unknownLayer.gateCommit).toBeUndefined();
	});
});

describe("applyOps policy injection", () => {
	it("injects policy gates on replace and preserves layer", () => {
		const result = applyOps(
			fileFromPhases([]),
			[{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "Implement UI", layer: "frontend" }] }] }],
			[],
			frontendPolicies,
		);

		const task = result.file.phases[0]?.tasks[0];
		if (!task) throw new Error("Expected task");
		expect(task.layer).toBe("frontend");
		expect(task.gateCommit).toBe(true);
		expect(task.gateCmd).toBe("bun test packages/coding-agent/test/tools/todo-write-policies.test.ts");
	});

	it("injects policy gates when layer is set via update", () => {
		const initial = fileFromPhases([
			makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Implement" })]),
		]);
		const result = applyOps(
			initial,
			[{ op: "update", id: "task-1", layer: "frontend" }],
			initial.phases,
			frontendPolicies,
		);
		const task = result.file.phases[0]?.tasks[0];
		if (!task) throw new Error("Expected task");
		expect(task.layer).toBe("frontend");
		expect(task.gateCommit).toBe(true);
		expect(task.verifyCmd).toBe("bun check packages/coding-agent/src/tools/todo-write.ts");
	});
});

describe("TodoWriteTool policy loading", () => {
	it("loads project policies and injects gates during execute", async () => {
		await fs.mkdir(path.join(tempDir, ".spell"), { recursive: true });
		await fs.writeFile(
			path.join(tempDir, ".spell", "task-policies.yml"),
			[
				"version: 1",
				"layers:",
				"  frontend:",
				"    description: Frontend work",
				"policies:",
				"  - name: frontend-gates",
				"    match:",
				"      layer: frontend",
				"    gates:",
				"      gateCommit: true",
				"      gateCmd: bun test packages/coding-agent/test/tools/todo-write-policies.test.ts",
				"      verifyCmd: bun check packages/coding-agent/src/tools/todo-write.ts",
			].join("\n"),
		);

		const tool = new TodoWriteTool(createSession(tempDir));
		const result = await tool.execute("call-1", {
			ops: [{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "Implement UI", layer: "frontend" }] }] }],
		});

		const task = result.details?.phases[0]?.tasks[0];
		if (!task) throw new Error("Expected task");
		expect(task.layer).toBe("frontend");
		expect(task.gateCommit).toBe(true);
		expect(task.gateCmd).toBe("bun test packages/coding-agent/test/tools/todo-write-policies.test.ts");
		expect(summaryText(result)).toContain("[frontend]");
	});
});

describe("formatSummary layer badges", () => {
	it("shows layer tag in remaining items summary", () => {
		const text = makeSummary({
			phases: [
				makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Implement UI", layer: "frontend" })]),
			],
		});

		expect(text).toContain("task-1 Implement UI [pending] [frontend] (Work)");
	});
});
