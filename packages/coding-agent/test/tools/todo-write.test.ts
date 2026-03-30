import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@oh-my-pi/pi-coding-agent/tools";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
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

describe("TodoWriteTool auto-start behavior", () => {
	it("auto-starts the first task after replace", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Execution",
							tasks: [{ content: "status" }, { content: "diagnostics" }],
						},
					],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("task-1 status [in_progress] (Execution)");
		expect(summary.text).toContain("task-2 diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Execution",
							tasks: [{ content: "status" }, { content: "diagnostics" }],
						},
					],
				},
			],
		});

		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", status: "completed" }],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("task-2 diagnostics [in_progress] (Execution)");

		const completedResult = await tool.execute("call-3", {
			ops: [{ op: "update", id: "task-2", status: "completed" }],
		});
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (!completedSummary || completedSummary.type !== "text") {
			throw new Error("Expected text summary from todo_write");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});

	it("keeps only one in_progress task when replace input contains multiples", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Execution",
							tasks: [
								{ content: "status", status: "in_progress" },
								{ content: "diagnostics", status: "in_progress" },
							],
						},
					],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});
});

describe("TodoWriteTool details field", () => {
	it("preserves details through replace op", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [
								{ content: "Fix parser", details: "Update src/parser.ts line 42" },
								{ content: "Add tests" },
							],
						},
					],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[0].details).toBe("Update src/parser.ts line 42");
		expect(tasks[1].details).toBeUndefined();
	});

	it("preserves details through add_task op", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "First" }] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [{ op: "add_task", phase: "phase-1", content: "Second", details: "Check edge cases" }],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[1].details).toBe("Check edge cases");
	});

	it("updates details via update op", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [{ name: "Work", tasks: [{ content: "Fix bug", details: "Old details" }] }],
				},
			],
		});

		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", details: "New details with\nlines" }],
		});

		const task = result.details?.phases[0]?.tasks[0];
		expect(task?.details).toBe("New details with\nlines");
	});

	it("includes details in summary for in_progress tasks", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Fix parser", details: "Edit src/parser.ts" }],
						},
					],
				},
			],
		});

		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary");
		// Task is auto-promoted to in_progress, so details should appear in summary
		expect(summary.text).toContain("Edit src/parser.ts");
	});
});

// =============================================================================
// BUG-022: Smart gate enforcement integration tests
// =============================================================================

describe("TodoWriteTool smart gate enforcement", () => {
	it("rejects update to in_progress when task has unresolved blocker", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Build schema" }, { content: "Build API", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		// Try to start blocked task
		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-2", status: "in_progress" }],
		});

		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).toContain("Cannot start task-2: blocked by task-1 (in_progress)");
		// task-2 should still be pending
		const task2 = result.details?.phases[0]?.tasks[1];
		expect(task2?.status).toBe("pending");
	});

	it("allows update to completed on task with unresolved blocker", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Build schema" }, { content: "Build API", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-2", status: "completed" }],
		});

		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).not.toContain("Cannot start");
		const task2 = result.details?.phases[0]?.tasks[1];
		expect(task2?.status).toBe("completed");
	});

	it("allows update to abandoned on task with unresolved blocker", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Build schema" }, { content: "Build API", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-2", status: "abandoned" }],
		});

		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).not.toContain("Cannot start");
		const task2 = result.details?.phases[0]?.tasks[1];
		expect(task2?.status).toBe("abandoned");
	});

	it("batch ops: complete blocker + start dependent in same ops array succeeds", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Build schema" }, { content: "Build API", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		// Complete blocker first, then start dependent in same batch
		const result = await tool.execute("call-2", {
			ops: [
				{ op: "update", id: "task-1", status: "completed" },
				{ op: "update", id: "task-2", status: "in_progress" },
			],
		});

		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).not.toContain("Cannot start");
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[0].status).toBe("completed");
		expect(tasks[1].status).toBe("in_progress");
	});

	it("batch ops: start dependent BEFORE completing blocker fails", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Build schema" }, { content: "Build API", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		// Try to start dependent before completing blocker
		const result = await tool.execute("call-2", {
			ops: [
				{ op: "update", id: "task-2", status: "in_progress" },
				{ op: "update", id: "task-1", status: "completed" },
			],
		});

		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).toContain("Cannot start task-2: blocked by task-1");
	});

	it("auto-promotion after completing blocker unblocks and promotes dependent", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Build schema" }, { content: "Build API", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		// Complete the blocker (task-1 auto-promoted to in_progress)
		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", status: "completed" }],
		});

		// task-2 should now be auto-promoted to in_progress since its blocker is resolved
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[0].status).toBe("completed");
		expect(tasks[1].status).toBe("in_progress");
	});

	it("dangling blocker ref produces warning", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Build API", blockers: ["task-99"] }],
						},
					],
				},
			],
		});

		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).toContain("Warning: task-1 references non-existent blocker task-99");
	});

	it("replace with in_progress blocked task demotes to pending", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Schema" }, { content: "API", status: "in_progress", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		// task-2 should be demoted to pending (blocked), task-1 should be auto-promoted
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[0].status).toBe("in_progress");
		expect(tasks[1].status).toBe("pending");
	});

	it("error message includes unresolved blocker IDs with statuses", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [
								{ content: "Schema" },
								{ content: "Tests" },
								{ content: "API", blockers: ["task-1", "task-2"] },
							],
						},
					],
				},
			],
		});

		// Complete task-1; task-2 auto-promoted to in_progress
		await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", status: "completed" }],
		});

		// Try to start task-3 - should fail because task-2 is still unresolved (auto-promoted to in_progress)
		const result = await tool.execute("call-3", {
			ops: [{ op: "update", id: "task-3", status: "in_progress" }],
		});

		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).toContain("Cannot start task-3: blocked by task-2 (in_progress)");
		// Should NOT mention task-1 since it's completed
		expect(summary).not.toContain("task-1 (completed)");
	});
});
