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

	it("auto-promotes first task when all created as pending", async () => {
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
			ops: [{ op: "update", id: "task-2", status: "abandoned", deferralFupId: "FUP-001-test" }],
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
		expect(summary).toContain("task-1 references non-existent blocker task-99");
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
							tasks: [{ content: "Schema" }, { content: "API", blockers: ["task-1"] }],
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

	it("add_phase with in_progress blocked task demotes to pending", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [{ name: "Setup", tasks: [{ content: "Schema" }] }],
				},
				{
					op: "add_phase",
					name: "Build",
					tasks: [{ content: "API", blockers: ["task-1"] }],
				},
			],
		});

		// task-2 (API) should be demoted to pending (blocked), task-1 should be auto-promoted
		const phases = result.details?.phases ?? [];
		expect(phases[0].tasks[0].status).toBe("in_progress");
		expect(phases[1].tasks[0].status).toBe("pending");
	});

	it("gate rejection preserves co-submitted field updates", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Schema" }, { content: "API", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		// Try to start blocked task with co-submitted notes
		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-2", status: "in_progress", notes: "starting this" }],
		});

		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).toContain("Cannot start task-2");
		// Status should be rejected
		const task2 = result.details?.phases[0]?.tasks[1];
		expect(task2?.status).toBe("pending");
		// But notes should be preserved
		expect(task2?.notes).toBe("starting this");
	});
});

// =============================================================================
// BUG-191: Per-op blocker validation and silent pruning
// =============================================================================

describe("TodoWriteTool blocker validation scope (BUG-191)", () => {
	it("dangling blocker introduced in same batch still warns", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [{ name: "Work", tasks: [{ content: "Build API", blockers: ["task-99"] }] }],
				},
			],
		});
		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).toContain("task-1 references non-existent blocker task-99");
	});

	it("pre-existing dangling blocker is silently pruned without warning", async () => {
		const tool = new TodoWriteTool(createSession());
		// First call: create tasks with a dangling blocker (in same batch, so a warning fires here).
		// We don't care about that warning; we're setting up the pre-existing state.
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Task A" }, { content: "Task B", blockers: ["task-1"] }],
						},
					],
				},
			],
		});

		// Second call: update Task A (complete it); Task B's blockers were NOT touched in this batch.
		// The blocker task-1 is now resolved, so pruning doesn't even matter here. Let's force a stale ref:
		// Complete task-1, then in a third call update task-2's notes — blocker ref should be silently pruned.
		await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", status: "completed" }],
		});

		// At this point task-2 has blockers: ["task-1"], which is completed, so treated as resolved.
		// Now do an unrelated update (notes only) that doesn't touch blockers.
		// The stale ref (completed task-1) is still there but should not surface a warning.
		const result = await tool.execute("call-3", {
			ops: [{ op: "update", id: "task-2", notes: "some notes" }],
		});
		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).not.toContain("references non-existent blocker");
	});

	it("pre-existing dangling blocker is pruned from stored task data", async () => {
		// Simulate a session that already has a task with a dangling blocker ref.
		const preExistingPhases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Work",
				tasks: [
					{
						id: "task-1",
						content: "Task A",
						status: "completed",
					},
					{
						id: "task-2",
						content: "Task B",
						status: "in_progress",
						// task-99 no longer exists — stale ref
						blockers: ["task-99"],
					},
				],
			},
		];
		const tool = new TodoWriteTool(createSession(preExistingPhases));

		// Update task-2's notes — does NOT touch blockers, so stale ref should be pruned silently.
		const result = await tool.execute("call-1", {
			ops: [{ op: "update", id: "task-2", notes: "updated" }],
		});

		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).not.toContain("references non-existent blocker");
		// task-99 should be removed from task-2's blockers
		const task2 = result.details?.phases[0]?.tasks[1];
		expect(task2?.blockers).toBeUndefined();
	});

	it("forward references inside a single replace batch are valid", async () => {
		// task-1 references task-2 (forward ref within the same replace op)
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Depends on next", blockers: ["task-2"] }, { content: "Independent" }],
						},
					],
				},
			],
		});
		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).not.toContain("references non-existent blocker");
		// task-1 should remain pending (blocked), task-2 should be in_progress
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[0].status).toBe("pending");
		expect(tasks[1].status).toBe("in_progress");
	});

	it("update op with explicit blockers set validates the new blockers", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [{ name: "Work", tasks: [{ content: "Task A" }, { content: "Task B" }] }],
				},
			],
		});

		// Set a dangling blocker via update — should warn
		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-2", blockers: ["task-99"] }],
		});
		const summary = result.content.find(part => part.type === "text")!.text!;
		expect(summary).toContain("task-2 references non-existent blocker task-99");
	});
});
