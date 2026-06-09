import { describe, expect, it } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import { type TodoNode, TodoWriteTool } from "../../src/tools/todo-write";

function createSession(initialNodes: TodoNode[] = []): ToolSession {
	let nodes = initialNodes;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoNodes: () => nodes,
		setTodoNodes: (next: TodoNode[]) => {
			nodes = next;
		},
	} as unknown as ToolSession;
}

/** Convenience: run a reconcile and return the resulting nodes + text summary. */
async function run(tool: TodoWriteTool, params: Parameters<TodoWriteTool["execute"]>[1]) {
	const result = await tool.execute(`call-${Math.random()}`, params);
	const nodes = result.details?.nodes ?? [];
	const text = result.content.find(part => part.type === "text");
	if (!text || text.type !== "text") throw new Error("Expected text summary from todo_write");
	return { nodes, text: text.text };
}

describe("TodoWriteTool reconcile + auto-start", () => {
	it("auto-starts the first task after reset", async () => {
		const tool = new TodoWriteTool(createSession());
		const { nodes, text } = await run(tool, {
			reset: true,
			tasks: [
				{ content: "status", group: "Execution" },
				{ content: "diagnostics", group: "Execution" },
			],
		});
		expect(nodes.map(n => n.status)).toEqual(["in_progress", "pending"]);
		expect(text).toContain("Remaining items (2):");
		expect(text).toContain("task-1 status [in_progress] (Execution)");
		expect(text).toContain("task-2 diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current completes", async () => {
		const tool = new TodoWriteTool(createSession());
		await run(tool, { reset: true, tasks: [{ content: "status" }, { content: "diagnostics" }] });

		const { nodes } = await run(tool, { tasks: [{ id: "task-1", status: "completed" }] });
		expect(nodes.map(n => n.status)).toEqual(["completed", "in_progress"]);

		const { text } = await run(tool, { tasks: [{ id: "task-2", status: "completed" }] });
		expect(text).toContain("Remaining items: none.");
	});
});

describe("TodoWriteTool upsert-by-id (merge, no reset)", () => {
	it("adds a new node without disturbing existing ones", async () => {
		const tool = new TodoWriteTool(createSession());
		await run(tool, { reset: true, tasks: [{ content: "First", group: "Work" }] });
		const { nodes } = await run(tool, { tasks: [{ content: "Second", group: "Work", details: "edge cases" }] });
		expect(nodes.map(n => n.content)).toEqual(["First", "Second"]);
		expect(nodes[1].details).toBe("edge cases");
	});

	it("patches an existing node by id, leaving others untouched", async () => {
		const tool = new TodoWriteTool(createSession());
		await run(tool, { reset: true, tasks: [{ content: "Fix bug", details: "Old" }, { content: "Test" }] });
		const { nodes } = await run(tool, { tasks: [{ id: "task-1", details: "New\nlines" }] });
		expect(nodes[0].details).toBe("New\nlines");
		expect(nodes[0].content).toBe("Fix bug");
		expect(nodes[1].content).toBe("Test");
	});

	it("rejects an unknown id with no content (cannot create)", async () => {
		const tool = new TodoWriteTool(createSession());
		const { text } = await run(tool, { tasks: [{ id: "task-99", status: "completed" }] });
		expect(text).toContain("not found");
	});
});

describe("TodoWriteTool reset semantics", () => {
	it("reset replaces the whole roster", async () => {
		const tool = new TodoWriteTool(createSession());
		await run(tool, { reset: true, tasks: [{ content: "A" }, { content: "B" }] });
		const { nodes } = await run(tool, { reset: true, tasks: [{ content: "C" }] });
		expect(nodes.map(n => n.content)).toEqual(["C"]);
		expect(nodes[0].id).toBe("task-1");
	});
});

describe("TodoWriteTool blockers / DAG", () => {
	it("does not auto-start a blocked node", async () => {
		const tool = new TodoWriteTool(createSession());
		const { nodes } = await run(tool, {
			reset: true,
			tasks: [
				{ content: "first" },
				{ content: "second", blockers: ["task-1"] },
			],
		});
		const second = nodes.find(n => n.id === "task-2")!;
		expect(second.status).toBe("pending");
	});

	it("refuses to start a node with an unresolved blocker", async () => {
		const tool = new TodoWriteTool(createSession());
		await run(tool, { reset: true, tasks: [{ content: "first" }, { content: "second", blockers: ["task-1"] }] });
		const { text } = await run(tool, { tasks: [{ id: "task-2", status: "in_progress" }] });
		expect(text).toContain("Cannot start task-2");
	});

	it("warns on circular blockers", async () => {
		const tool = new TodoWriteTool(createSession());
		const { text } = await run(tool, {
			reset: true,
			tasks: [
				{ content: "a", blockers: ["task-2"] },
				{ content: "b", blockers: ["task-1"] },
			],
		});
		expect(text).toContain("Circular blockers detected");
	});
});

describe("TodoWriteTool verify{} two-phase", () => {
	it("rejects completion of a gated node without verified:true", async () => {
		const tool = new TodoWriteTool(createSession());
		await run(tool, { reset: true, tasks: [{ content: "ship", verify: { cmd: "bun test" } }] });
		const { nodes, text } = await run(tool, { tasks: [{ id: "task-1", status: "completed" }] });
		expect(nodes[0].status).not.toBe("completed");
		expect(text).toContain("Verification Required");
		expect(text).toContain("verify.cmd");
	});

	it("review-only gate is advisory (still two-phase? no — review never gates)", async () => {
		const tool = new TodoWriteTool(createSession());
		await run(tool, { reset: true, tasks: [{ content: "doc", verify: { review: "check tone" } }] });
		const { nodes } = await run(tool, { tasks: [{ id: "task-1", status: "completed", verified: false }] });
		// review alone does not require verification → completion goes through
		expect(nodes[0].status).toBe("completed");
	});
});

describe("TodoWriteTool deferral", () => {
	it("rejects abandon without a deferralFupId", async () => {
		const tool = new TodoWriteTool(createSession());
		await run(tool, { reset: true, tasks: [{ content: "maybe" }] });
		const { nodes, text } = await run(tool, { tasks: [{ id: "task-1", status: "abandoned" }] });
		expect(nodes[0].status).not.toBe("abandoned");
		expect(text).toContain("Deferral Required");
	});

	it("accepts abandon with a deferralFupId", async () => {
		const tool = new TodoWriteTool(createSession());
		await run(tool, { reset: true, tasks: [{ content: "maybe" }] });
		const { nodes } = await run(tool, { tasks: [{ id: "task-1", status: "abandoned", deferralFupId: "FUP-1" }] });
		expect(nodes[0].status).toBe("abandoned");
		expect(nodes[0].deferralFupId).toBe("FUP-1");
	});
});

describe("TodoWriteTool group label clustering", () => {
	it("groups are cosmetic and render under their label", async () => {
		const tool = new TodoWriteTool(createSession());
		const { text } = await run(tool, {
			reset: true,
			tasks: [
				{ content: "a", group: "alpha" },
				{ content: "b", group: "beta" },
			],
		});
		expect(text).toContain("(alpha)");
		expect(text).toContain("(beta)");
	});
});
