import { beforeEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@oh-my-pi/pi-coding-agent/tools";
import * as orgModule from "@oh-my-pi/pi-org";

interface MockItem {
	id: string;
	file: string;
	state: string;
	body?: string;
}

function createSession(options: { phases?: TodoPhase[]; orgEnabled?: boolean } = {}): ToolSession {
	let phases = options.phases ?? [];
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "org.enabled": options.orgEnabled ?? true }),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

describe("TodoWriteTool org lifecycle hooks", () => {
	let items: Map<string, MockItem>;
	let updateItemStateSpy: ReturnType<typeof vi.spyOn<typeof orgModule, "updateItemStateInFile">>;

	beforeEach(() => {
		vi.restoreAllMocks();
		items = new Map<string, MockItem>([
			["FEAT-001", { id: "FEAT-001", file: "/tmp/feat-001.org", state: "ITEM" }],
			["FEAT-002", { id: "FEAT-002", file: "/tmp/feat-002.org", state: "ITEM" }],
		]);
		vi.spyOn(orgModule, "resolveCategories").mockReturnValue([
			{ absPath: "/tmp/tasks", name: "tasks", dirName: "tasks" },
		] as unknown as ReturnType<typeof orgModule.resolveCategories>);
		vi.spyOn(orgModule, "findItemById").mockImplementation(async (_dirs, id) => {
			const item = items.get(id);
			return (item ? { ...item } : null) as unknown as Awaited<ReturnType<typeof orgModule.findItemById>>;
		});
		updateItemStateSpy = vi.spyOn(orgModule, "updateItemStateInFile").mockImplementation(async (file, id, state) => {
			const item = items.get(id);
			if (!item) return false;
			item.file = file;
			item.state = state;
			return true;
		});
	});

	test("auto-transitions orgItemId task to DOING when work starts", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "Implement", orgItemId: "FEAT-001" }] }] }],
		});

		expect(updateItemStateSpy).toHaveBeenCalledWith("/tmp/feat-001.org", "FEAT-001", "DOING", expect.any(Array));
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("INFO: Org item FEAT-001 auto-transitioned to DOING.");
	});

	test("auto-transitions orgItemClosingId task to DONE only after verified completion", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{ name: "Work", tasks: [{ content: "Ship", orgItemId: "FEAT-001", orgItemClosingId: "FEAT-001" }] },
					],
				},
			],
		});
		updateItemStateSpy.mockClear();

		await tool.execute("call-2", { ops: [{ op: "update", id: "task-1", status: "completed" }] });
		expect(updateItemStateSpy).not.toHaveBeenCalled();

		const accepted = await tool.execute("call-3", {
			ops: [{ op: "update", id: "task-1", status: "completed", verified: true }],
		});
		expect(updateItemStateSpy).toHaveBeenCalledWith("/tmp/feat-001.org", "FEAT-001", "DONE", expect.any(Array));
		const text = accepted.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("INFO: Org item FEAT-001 auto-transitioned to DONE.");
	});

	test("skips hooks cleanly when org is disabled", async () => {
		const tool = new TodoWriteTool(createSession({ orgEnabled: false }));
		await tool.execute("call-1", {
			ops: [{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "Implement", orgItemId: "FEAT-001" }] }] }],
		});
		expect(updateItemStateSpy).not.toHaveBeenCalled();
	});

	test("surfaces WARN notice when org item is missing", async () => {
		items.delete("FEAT-001");
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "Implement", orgItemId: "FEAT-001" }] }] }],
		});
		expect(updateItemStateSpy).not.toHaveBeenCalled();
		expect(result.details?.phases[0]?.tasks[0]?.status).toBe("in_progress");
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("WARN: Org item FEAT-001 not found for DOING transition.");
	});

	test("surfaces WARN notice when org transition throws", async () => {
		vi.spyOn(orgModule, "findItemById").mockRejectedValue(new Error("connection refused"));
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "Implement", orgItemId: "FEAT-001" }] }] }],
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("WARN: Failed to transition org item FEAT-001 to DOING: connection refused");
		// Task should still be in_progress despite the org hook failure
		expect(result.details?.phases[0]?.tasks[0]?.status).toBe("in_progress");
	});

	test("shared orgItemId only transitions to DOING once", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [
								{ content: "First", orgItemId: "FEAT-001" },
								{ content: "Second", orgItemId: "FEAT-001" },
							],
						},
					],
				},
			],
		});
		updateItemStateSpy.mockClear();

		await tool.execute("call-2", { ops: [{ op: "update", id: "task-1", status: "completed" }] });
		expect(updateItemStateSpy).not.toHaveBeenCalled();
	});

	test("todo_write does not auto-complete the parent plan", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "Finish", orgItemClosingId: "FEAT-001" }] }] },
			],
		});

		await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", status: "completed", verified: true }],
		});

		expect(updateItemStateSpy).toHaveBeenCalledWith("/tmp/feat-001.org", "FEAT-001", "DONE", expect.any(Array));
	});
});
