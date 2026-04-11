import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import { type TodoGroup, TodoWriteTool } from "../../src/tools/todo-write";
import { FakeEventBus } from "../../src/utils/fake-event-bus";

function createSession(initialPhases: TodoGroup[] = [], eventBus = new FakeEventBus()): ToolSession {
	let groups = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => "sess-test",
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		eventBus,
		getTodoGroups: () => groups,
		setTodoGroups: next => {
			groups = next;
		},
	};
}

describe("todo_write DAG semantics", () => {
	test("replace assigns canonical URIs and honors blocker DAG edges", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					groups: [
						{
							name: "Execution",
							tasks: [{ content: "A" }, { content: "B", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks[0]?.uri).toBe("task://sess-test/main/task-1");
		expect(tasks[1]?.uri).toBe("task://sess-test/main/task-2");
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});

	test("add_group is cosmetic and still materializes grouped tasks", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [{ op: "add_group", name: "foundation", tasks: [{ content: "Define schema" }] }],
		});

		expect(result.details?.groups.map(group => group.name)).toEqual(["foundation"]);
		expect(result.details?.groups[0]?.tasks[0]?.status).toBe("in_progress");
	});

	test("emits fine-grained events for task creation and status changes", async () => {
		const eventBus = new FakeEventBus();
		const tool = new TodoWriteTool(createSession([], eventBus));
		await tool.execute("call-1", {
			ops: [{ op: "replace", groups: [{ name: "work", tasks: [{ content: "A" }] }] }],
		});
		await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", status: "completed" }],
		});

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
			ops: [
				{
					op: "replace",
					groups: [{ name: "work", tasks: [{ content: "A" }, { content: "B", blockers: ["task-1"] }] }],
				},
			],
		});

		expect(result.details?.groups[0]?.tasks.map(task => task.blockers)).toEqual([undefined, ["task-1"]]);
	});

	test("gated completion still requires verified true", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					groups: [{ name: "work", tasks: [{ content: "Verify", gateCmd: "bun test test/foo.test.ts" }] }],
				},
			],
		});
		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", status: "completed" }],
		});

		expect(result.details?.groups[0]?.tasks[0]?.status).toBe("in_progress");
		const summary = result.content.find(part => part.type === "text");
		expect(summary?.text).toContain("requires verification before completion");
	});
});
