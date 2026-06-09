/**
 * Property / fuzz tests for the todo_write reconcile engine (PLAN-328).
 *
 * No external property-test dependency — a small seeded LCG drives a
 * deterministic generator so failures are reproducible (the seed is printed in
 * each assertion message). Each property runs over RUNS random inputs and
 * asserts an invariant that must hold for ALL of them.
 *
 * Invariants under test:
 *   P1  reconcile is idempotent — re-submitting the same desired state is a no-op
 *   P2  upsert-by-id never drops or duplicates a node id
 *   P3  reset always yields exactly the submitted node count, ids task-1..N
 *   P4  blockers never let a node auto-start before its blocker resolves
 *   P5  a node is never simultaneously two statuses; ids stay unique
 *   P6  verify{cmd|artifact|commit} ⇒ completion is two-phase (needs verified)
 *   P7  the engine never throws and always returns a well-formed roster
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import { type TodoNode, TodoWriteTool } from "../../src/tools/todo-write";

const RUNS = 200;

/** Deterministic LCG (numerical-recipes constants) — reproducible from a seed. */
class Rng {
	#state: number;
	constructor(seed: number) {
		this.#state = seed >>> 0;
	}
	next(): number {
		this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0;
		return this.#state / 0x100000000;
	}
	int(maxExclusive: number): number {
		return Math.floor(this.next() * maxExclusive);
	}
	pick<T>(arr: readonly T[]): T {
		return arr[this.int(arr.length)]!;
	}
	bool(p = 0.5): boolean {
		return this.next() < p;
	}
}

function createSession(): ToolSession {
	let nodes: TodoNode[] = [];
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

type Params = Parameters<TodoWriteTool["execute"]>[1];

async function run(tool: TodoWriteTool, params: Params): Promise<TodoNode[]> {
	const result = await tool.execute(`call-${Math.random()}`, params);
	return result.details?.nodes ?? [];
}

/** Generate a random "initial plan" reset payload of 1..6 nodes. */
function genResetPlan(rng: Rng): Params {
	const n = 1 + rng.int(6);
	const groups = ["alpha", "beta", undefined, undefined];
	const tasks = Array.from({ length: n }, (_, i) => {
		const node: Record<string, unknown> = { content: `task content ${i}` };
		const g = rng.pick(groups);
		if (g) node.group = g;
		// chain some blockers to a strictly-earlier node (acyclic by construction)
		if (i > 0 && rng.bool(0.4)) node.blockers = [`task-${rng.int(i) + 1}`];
		if (rng.bool(0.3)) {
			const v: Record<string, unknown> = {};
			if (rng.bool()) v.cmd = "bun test";
			if (rng.bool(0.3)) v.commit = true;
			if (rng.bool(0.2)) v.review = "look it over";
			if (Object.keys(v).length > 0) node.verify = v;
		}
		return node;
	});
	return { reset: true, tasks: tasks as Params["tasks"] };
}

function uniqueIds(nodes: TodoNode[]): boolean {
	return new Set(nodes.map(n => n.id)).size === nodes.length;
}

const VALID_STATUSES = new Set(["pending", "in_progress", "completed", "abandoned", "failed", "gate_failed"]);

function wellFormed(nodes: TodoNode[]): boolean {
	return (
		uniqueIds(nodes) &&
		nodes.every(n => typeof n.id === "string" && n.id.length > 0 && VALID_STATUSES.has(n.status) && typeof n.content === "string")
	);
}

describe("todo_write reconcile — property/fuzz", () => {
	it("P3+P7: reset yields exactly N well-formed nodes, never throws", async () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed);
			const plan = genResetPlan(rng);
			const tool = new TodoWriteTool(createSession());
			const nodes = await run(tool, plan);
			expect(nodes.length, `seed=${seed}`).toBe(plan.tasks.length);
			expect(wellFormed(nodes), `seed=${seed} ids=${nodes.map(n => n.id)}`).toBe(true);
			// ids are task-1..N
			expect(nodes.map(n => n.id).sort(), `seed=${seed}`).toEqual(
				plan.tasks.map((_, i) => `task-${i + 1}`).sort(),
			);
		}
	});

	it("P1: reconcile is idempotent — re-submitting current state changes nothing", async () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 10_000);
			const tool = new TodoWriteTool(createSession());
			const first = await run(tool, genResetPlan(rng));
			// Re-submit the SAME desired content for every node by id (no status change).
			const echo: Params = {
				tasks: first.map(n => ({ id: n.id, content: n.content })) as Params["tasks"],
			};
			const second = await run(tool, echo);
			expect(second.length, `seed=${seed}`).toBe(first.length);
			for (const before of first) {
				const after = second.find(n => n.id === before.id)!;
				expect(after, `seed=${seed} missing ${before.id}`).toBeDefined();
				expect(after.status, `seed=${seed} ${before.id} status drift`).toBe(before.status);
				expect(after.content, `seed=${seed} ${before.id} content drift`).toBe(before.content);
			}
		}
	});

	it("P2+P5: random upsert sequence preserves id uniqueness & valid statuses", async () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 20_000);
			const tool = new TodoWriteTool(createSession());
			let nodes = await run(tool, genResetPlan(rng));
			const ops = 1 + rng.int(5);
			for (let k = 0; k < ops; k++) {
				if (nodes.length === 0) break;
				const target = rng.pick(nodes);
				// random legal-ish mutation: patch details, or add a brand-new node
				const params: Params = rng.bool()
					? { tasks: [{ id: target.id, details: `note ${k}` }] }
					: { tasks: [{ content: `added ${k}`, group: rng.bool() ? "alpha" : undefined }] };
				nodes = await run(tool, params);
				expect(wellFormed(nodes), `seed=${seed} op=${k}`).toBe(true);
			}
		}
	});

	it("P4: a blocked node is never auto-promoted to in_progress", async () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 30_000);
			const tool = new TodoWriteTool(createSession());
			const nodes = await run(tool, genResetPlan(rng));
			for (const node of nodes) {
				const blockers = node.blockers ?? [];
				if (blockers.length === 0) continue;
				const anyUnresolved = blockers.some(b => {
					const blocker = nodes.find(n => n.id === b);
					return blocker && blocker.status !== "completed" && blocker.status !== "abandoned";
				});
				if (anyUnresolved) {
					expect(node.status, `seed=${seed} ${node.id} blocked but ${node.status}`).not.toBe("in_progress");
				}
			}
		}
	});

	it("P5b: at most one direct node is in_progress after a fresh reset plan", async () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 40_000);
			const tool = new TodoWriteTool(createSession());
			const nodes = await run(tool, genResetPlan(rng));
			const running = nodes.filter(n => n.status === "in_progress");
			expect(running.length, `seed=${seed} running=${running.map(n => n.id)}`).toBeLessThanOrEqual(1);
		}
	});

	it("P6: verify{cmd|artifact|commit} completion is always two-phase", async () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 50_000);
			const tool = new TodoWriteTool(createSession());
			const gate = rng.pick([{ cmd: "bun test" }, { artifact: "dist/x" }, { commit: true }] as const);
			await run(tool, { reset: true, tasks: [{ content: "gated", verify: { ...gate } }] });
			// Attempt completion WITHOUT verified — must be rejected.
			const after = await run(tool, { tasks: [{ id: "task-1", status: "completed" }] });
			expect(after[0]?.status, `seed=${seed} gate=${JSON.stringify(gate)}`).not.toBe("completed");
		}
	});
});
