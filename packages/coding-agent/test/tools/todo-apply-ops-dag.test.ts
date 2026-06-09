import { describe, expect, test } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import { type TodoNode, TodoWriteTool } from "../../src/tools/todo-write";
import { FakeEventBus } from "../../src/utils/fake-event-bus";

function createSession(initialNodes: TodoNode[] = [], eventBus = new FakeEventBus()): ToolSession {
	let nodes = initialNodes;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => "sess-test",
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		eventBus,
		getTodoNodes: () => nodes,
		setTodoNodes: (next: TodoNode[]) => {
			nodes = next;
		},
	} as unknown as ToolSession;
}

describe("todo_write DAG semantics", () => {
	test("reset assigns canonical URIs and honors blocker DAG edges", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "A" }, { content: "B", blockers: ["task-1"] }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0]?.uri).toBe("task://sess-test/main/task-1");
		expect(nodes[1]?.uri).toBe("task://sess-test/main/task-2");
		expect(nodes.map(n => n.status)).toEqual(["in_progress", "pending"]);
	});

	test("group label is cosmetic and still materializes nodes", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Define schema", group: "foundation" }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes.map(n => n.group)).toEqual(["foundation"]);
		expect(nodes[0]?.status).toBe("in_progress");
	});

	test("emits fine-grained events for task creation and status changes", async () => {
		const eventBus = new FakeEventBus();
		const tool = new TodoWriteTool(createSession([], eventBus));
		await tool.execute("call-1", { reset: true, tasks: [{ content: "A", group: "work" }] });
		await tool.execute("call-2", { tasks: [{ id: "task-1", status: "completed" }] });

		expect(eventBus.emittedFor("todo:task:created")).toEqual([
			{ taskUri: "task://sess-test/main/task-1", kind: "work", slug: "task-1" },
		]);
		expect(eventBus.emittedFor("todo:task:status")).toEqual([
			{ taskUri: "task://sess-test/main/task-1", from: "pending", to: "in_progress" },
			{ taskUri: "task://sess-test/main/task-1", from: "in_progress", to: "completed" },
		]);
	});

	test("numeric task-N blockers remain valid slugs", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "A", group: "work" }, { content: "B", group: "work", blockers: ["task-1"] }],
		});

		expect((result.details?.nodes ?? []).map(n => n.blockers)).toEqual([undefined, ["task-1"]]);
	});

	test("gated completion still requires verified true", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			reset: true,
			tasks: [{ content: "Verify", group: "work", verify: { cmd: "bun test test/foo.test.ts" } }],
		});
		const result = await tool.execute("call-2", { tasks: [{ id: "task-1", status: "completed" }] });

		expect(result.details?.nodes[0]?.status).toBe("in_progress");
		const summary = result.content.find(part => part.type === "text");
		expect(summary?.text).toContain("requires verification before completion");
	});
});
