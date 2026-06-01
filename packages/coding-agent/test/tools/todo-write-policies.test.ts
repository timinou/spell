import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { TaskPolicy } from "../../src/config/task-policies";
import type { ToolSession } from "../../src/tools";
import {
	applyOps,
	type FormatSummaryOptions,
	formatSummary,
	getNextTodoIds,
	injectPolicyGates,
	type TodoGroup,
	type TodoItem,
	type TodoStatus,
	TodoWriteTool,
} from "../../src/tools/todo-write";

function makeTask(overrides: Partial<TodoItem> & { id: string; content: string }): TodoItem {
	return { status: "pending" as TodoStatus, ...overrides };
}

function makePhase(id: string, name: string, tasks: TodoItem[]): TodoGroup {
	return { id, name, tasks };
}

function fileFromPhases(phases: TodoGroup[]) {
	const { nextTaskId, nextGroupId } = getNextTodoIds(phases);
	return { groups: phases, nextTaskId, nextGroupId };
}

function createSession(cwd: string, initialGroups: TodoGroup[] = [], policies?: TaskPolicy[]): ToolSession {
	let groups = initialGroups;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoGroups: () => groups,
		setTodoGroups: next => {
			groups = next;
		},
		getResolvedTaskPolicies: policies ? () => policies : undefined,
	};
}

function summaryText(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find(entry => entry.type === "text");
	if (!part || part.type !== "text" || !part.text) throw new Error("Expected text summary from todo_write");
	return part.text;
}

function makeSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
	return formatSummary({
		groups: overrides.groups ?? [makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Do work" })])],
		errors: overrides.errors ?? [],
		completedGroupIds: overrides.completedGroupIds ?? [],
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
			[{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "Implement UI", layer: "frontend" }] }] }],
			[],
			frontendPolicies,
		);

		const task = result.file.groups[0]?.tasks[0];
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
			initial.groups,
			frontendPolicies,
		);
		const task = result.file.groups[0]?.tasks[0];
		if (!task) throw new Error("Expected task");
		expect(task.layer).toBe("frontend");
		expect(task.gateCommit).toBe(true);
		expect(task.verifyCmd).toBe("bun check packages/coding-agent/src/tools/todo-write.ts");
	});

	it("injects policy gates on add_phase with layer", () => {
		const initial = fileFromPhases([
			makePhase("phase-1", "Existing", [makeTask({ id: "task-1", content: "Setup" })]),
		]);
		const result = applyOps(
			initial,
			[{ op: "add_phase", name: "Frontend", tasks: [{ content: "Build UI", layer: "frontend" }] }],
			initial.groups,
			frontendPolicies,
		);

		const addedPhase = result.file.groups[1];
		if (!addedPhase) throw new Error("Expected added phase");
		const task = addedPhase.tasks[0];
		if (!task) throw new Error("Expected task in added phase");
		expect(task.layer).toBe("frontend");
		expect(task.gateCommit).toBe(true);
		expect(task.gateCmd).toBe("bun test packages/coding-agent/test/tools/todo-write-policies.test.ts");
		expect(task.verifyCmd).toBe("bun check packages/coding-agent/src/tools/todo-write.ts");
	});
});

describe("TodoWriteTool session policy injection", () => {
	it("uses session-provided policies to inject gates during execute", async () => {
		const sessionPolicies: TaskPolicy[] = [
			{
				name: "frontend-gates",
				match: { layer: "frontend" },
				gates: {
					gateCommit: true,
					gateCmd: "bun test packages/coding-agent/test/tools/todo-write-policies.test.ts",
					verifyCmd: "bun check packages/coding-agent/src/tools/todo-write.ts",
				},
			},
		];
		const tool = new TodoWriteTool(createSession(tempDir, [], sessionPolicies));
		const result = await tool.execute("call-1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "Implement UI", layer: "frontend" }] }] }],
		});

		const task = result.details?.groups[0]?.tasks[0];
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
			groups: [
				makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Implement UI", layer: "frontend" })]),
			],
		});

		expect(text).toContain("task-1 Implement UI [pending] [frontend] (Work)");
	});
});
