import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { TaskPolicy } from "../../src/config/task-policies";
import type { ToolSession } from "../../src/tools";
import {
	applyReconcile,
	type FormatSummaryOptions,
	formatSummary,
	injectPolicyGates,
	type TodoNode,
	type TodoStatus,
	TodoWriteTool,
} from "../../src/tools/todo-write";

function makeNode(overrides: Partial<TodoNode> & { id: string; content: string }): TodoNode {
	return { status: "pending" as TodoStatus, ...overrides };
}

function fileFromNodes(nodes: TodoNode[]) {
	const maxTaskId = nodes.reduce((max, n) => {
		const num = Number.parseInt(n.id.replace(/^task-/, ""), 10);
		return Number.isNaN(num) ? max : Math.max(max, num);
	}, 0);
	return { nodes, nextTaskId: maxTaskId + 1 };
}

function createSession(cwd: string, initialNodes: TodoNode[] = [], policies?: TaskPolicy[]): ToolSession {
	let nodes = initialNodes;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoNodes: () => nodes,
		setTodoNodes: (next: TodoNode[]) => {
			nodes = next;
		},
		getResolvedTaskPolicies: policies ? () => policies : undefined,
	} as unknown as ToolSession;
}

function summaryText(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find(entry => entry.type === "text");
	if (!part || part.type !== "text" || !part.text) throw new Error("Expected text summary from todo_write");
	return part.text;
}

function makeSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
	return formatSummary({
		nodes: overrides.nodes ?? [makeNode({ id: "task-1", content: "Do work", group: "Work" })],
		errors: overrides.errors ?? [],
		completedGroups: overrides.completedGroups ?? [],
		completedGatedNodes: overrides.completedGatedNodes ?? [],
		pendingVerificationNodes: overrides.pendingVerificationNodes ?? [],
		pendingDeferralNodes: overrides.pendingDeferralNodes ?? [],
	});
}

const frontendPolicies: TaskPolicy[] = [
	{
		name: "frontend-defaults",
		match: { layer: "frontend" },
		verify: {
			cmd: "bun test packages/coding-agent/test/tools/todo-write-policies.test.ts",
			review: "bun check packages/coding-agent/src/tools/todo-write.ts",
		},
	},
	{
		name: "frontend-commit",
		match: { layer: "frontend" },
		verify: { commit: true },
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
		const node = makeNode({
			id: "task-1",
			content: "Implement UI",
			layer: "frontend",
			verify: { cmd: "bun test explicit.test.ts" },
		});

		injectPolicyGates(node, frontendPolicies);

		expect(node.verify?.cmd).toBe("bun test explicit.test.ts");
		expect(node.verify?.commit).toBe(true);
		expect(node.verify?.review).toBe("bun check packages/coding-agent/src/tools/todo-write.ts");
	});

	it("does nothing when layer is missing or unmatched", () => {
		const withoutLayer = makeNode({ id: "task-1", content: "A" });
		const unknownLayer = makeNode({ id: "task-2", content: "B", layer: "backend" });

		injectPolicyGates(withoutLayer, frontendPolicies);
		injectPolicyGates(unknownLayer, frontendPolicies);

		expect(withoutLayer.verify?.commit).toBeUndefined();
		expect(unknownLayer.verify?.commit).toBeUndefined();
	});
});

describe("applyReconcile policy injection", () => {
	it("injects policy gates on reset and preserves layer", () => {
		const result = applyReconcile(
			fileFromNodes([]),
			{ reset: true, tasks: [{ content: "Implement UI", layer: "frontend" }] },
			[],
			frontendPolicies,
		);

		const node = result.file.nodes[0];
		if (!node) throw new Error("Expected node");
		expect(node.layer).toBe("frontend");
		expect(node.verify?.commit).toBe(true);
		expect(node.verify?.cmd).toBe("bun test packages/coding-agent/test/tools/todo-write-policies.test.ts");
	});

	it("injects policy gates when layer is set via update", () => {
		const initial = fileFromNodes([makeNode({ id: "task-1", content: "Implement" })]);
		const result = applyReconcile(
			initial,
			{ tasks: [{ id: "task-1", layer: "frontend" }] },
			initial.nodes,
			frontendPolicies,
		);
		const node = result.file.nodes[0];
		if (!node) throw new Error("Expected node");
		expect(node.layer).toBe("frontend");
		expect(node.verify?.commit).toBe(true);
		expect(node.verify?.review).toBe("bun check packages/coding-agent/src/tools/todo-write.ts");
	});

	it("injects policy gates when adding new node with layer", () => {
		const initial = fileFromNodes([makeNode({ id: "task-1", content: "Setup" })]);
		const result = applyReconcile(
			initial,
			{ tasks: [{ content: "Build UI", layer: "frontend", group: "Frontend" }] },
			initial.nodes,
			frontendPolicies,
		);

		const addedNode = result.file.nodes[1];
		if (!addedNode) throw new Error("Expected added node");
		expect(addedNode.layer).toBe("frontend");
		expect(addedNode.verify?.commit).toBe(true);
		expect(addedNode.verify?.cmd).toBe("bun test packages/coding-agent/test/tools/todo-write-policies.test.ts");
		expect(addedNode.verify?.review).toBe("bun check packages/coding-agent/src/tools/todo-write.ts");
	});
});

describe("TodoWriteTool session policy injection", () => {
	it("uses session-provided policies to inject gates during execute", async () => {
		const sessionPolicies: TaskPolicy[] = [
			{
				name: "frontend-gates",
				match: { layer: "frontend" },
				verify: {
					commit: true,
					cmd: "bun test packages/coding-agent/test/tools/todo-write-policies.test.ts",
					review: "bun check packages/coding-agent/src/tools/todo-write.ts",
				},
			},
		];
		const tool = new TodoWriteTool(createSession(tempDir, [], sessionPolicies));
		const result = await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Implement UI", layer: "frontend", group: "Work" }],
		});

		const node = result.details?.nodes[0];
		if (!node) throw new Error("Expected node");
		expect(node.layer).toBe("frontend");
		expect(node.verify?.commit).toBe(true);
		expect(node.verify?.cmd).toBe("bun test packages/coding-agent/test/tools/todo-write-policies.test.ts");
		expect(summaryText(result)).toContain("[frontend]");
	});
});

describe("formatSummary layer badges", () => {
	it("shows layer tag in remaining items summary", () => {
		const text = makeSummary({
			nodes: [makeNode({ id: "task-1", content: "Implement UI", layer: "frontend", group: "Work" })],
		});

		expect(text).toContain("task-1 Implement UI [pending] [frontend] (Work)");
	});
});
