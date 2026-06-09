import { describe, expect, it } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import type { TodoNode } from "../../src/tools/todo-write";
import { queueTodoMutation, TodoWriteTool } from "../../src/tools/todo-write";

function createMockSession(): ToolSession {
	return {} as ToolSession;
}

function createTodoWriteSession() {
	let nodes: TodoNode[] = [];
	const session = {
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
	return { session, getNodes: () => nodes };
}

describe("queueTodoMutation serialization", () => {
	it("serializes concurrent mutations within a session", async () => {
		const session = createMockSession();
		const order: string[] = [];

		const first = queueTodoMutation(session, async () => {
			order.push("start-1");
			await Bun.sleep(20);
			order.push("end-1");
		});
		const second = queueTodoMutation(session, async () => {
			order.push("start-2");
			order.push("end-2");
		});

		await Promise.all([first, second]);
		expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
	});

	it("runs nested mutation inline without deadlock", async () => {
		const session = createMockSession();
		const order: string[] = [];

		await queueTodoMutation(session, async () => {
			order.push("outer-start");
			await queueTodoMutation(session, async () => {
				order.push("inner-start");
				order.push("inner-end");
			});
			order.push("outer-end");
		});

		expect(order).toEqual(["outer-start", "inner-start", "inner-end", "outer-end"]);
	});

	it("keeps three concurrent updates consistent", async () => {
		const session = createMockSession();
		const state = { counter: 0 };

		const mutate = () =>
			queueTodoMutation(session, async () => {
				const current = state.counter;
				await Bun.sleep(5);
				state.counter = current + 1;
			});

		await Promise.all([mutate(), mutate(), mutate()]);
		expect(state.counter).toBe(3);
	});

	it("does not serialize mutations across sessions", async () => {
		const sessionA = createMockSession();
		const sessionB = createMockSession();
		const order: string[] = [];

		await Promise.all([
			queueTodoMutation(sessionA, async () => {
				order.push("start-a");
				await Bun.sleep(20);
				order.push("end-a");
			}),
			queueTodoMutation(sessionB, async () => {
				order.push("start-b");
				await Bun.sleep(20);
				order.push("end-b");
			}),
		]);

		const firstEnd = Math.min(order.indexOf("end-a"), order.indexOf("end-b"));
		const lastStart = Math.max(order.indexOf("start-a"), order.indexOf("start-b"));
		expect(firstEnd).toBeGreaterThan(lastStart);
	});

	it("propagates action errors to caller", async () => {
		const session = createMockSession();
		const error = new Error("queue failed");

		await expect(
			queueTodoMutation(session, async () => {
				throw error;
			}),
		).rejects.toBe(error);
	});

	it("drains queued mutations after an error", async () => {
		const session = createMockSession();
		const error = new Error("first failed");
		const order: string[] = [];

		const first = queueTodoMutation(session, async () => {
			order.push("first");
			throw error;
		});
		const second = queueTodoMutation(session, async () => {
			order.push("second");
			return "ok";
		});

		await expect(first).rejects.toBe(error);
		await expect(second).resolves.toBe("ok");
		expect(order).toEqual(["first", "second"]);
	});
});

describe("TodoWriteTool verificationArtifact serialization", () => {
	it("round-trips verificationArtifact through add and update operations", async () => {
		const { session, getNodes } = createTodoWriteSession();
		const tool = new TodoWriteTool(session);

		await tool.execute("call-add", {
			tasks: [
				{
					content: "Delegate verification",
					group: "Work",
					verificationArtifact: "artifacts/verification.json",
				},
			],
		});
		expect(getNodes()[0]?.verificationArtifact).toBe("artifacts/verification.json");

		const updated = await tool.execute("call-update", {
			tasks: [{ id: "task-1", verificationArtifact: "artifacts/verification-final.json" }],
		});
		expect(updated.details?.nodes[0]?.verificationArtifact).toBe("artifacts/verification-final.json");
	});
});
