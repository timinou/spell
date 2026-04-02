import { describe, expect, test } from "bun:test";
import { type BatchTask, buildBatchGraph, scheduleBatch } from "../../src/task/batch-scheduler";

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error?: unknown) => void;
} {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	return { promise, resolve, reject };
}

describe("batch scheduler", () => {
	test("executes blocker-free tasks in input order", async () => {
		const started: string[] = [];
		const results = await scheduleBatch(
			["A", "B", "C"].map(
				id =>
					({
						id,
						run: async () => {
							started.push(id);
							return `${id}-done`;
						},
					}) satisfies BatchTask<string>,
			),
			{ maxConcurrency: 3 },
		);

		expect(started).toEqual(["A", "B", "C"]);
		expect(results).toEqual([
			{ id: "A", status: "completed", result: "A-done" },
			{ id: "B", status: "completed", result: "B-done" },
			{ id: "C", status: "completed", result: "C-done" },
		]);
	});

	test("executes a linear chain in topological order", async () => {
		const events: string[] = [];
		const results = await scheduleBatch(
			[
				{
					id: "A",
					run: async () => {
						events.push("start:A");
						await Bun.sleep(5);
						events.push("end:A");
						return "A";
					},
				},
				{
					id: "B",
					blockers: ["A"],
					run: async () => {
						events.push("start:B");
						await Bun.sleep(5);
						events.push("end:B");
						return "B";
					},
				},
				{
					id: "C",
					blockers: ["B"],
					run: async () => {
						events.push("start:C");
						events.push("end:C");
						return "C";
					},
				},
			],
			{ maxConcurrency: 3 },
		);

		expect(events).toEqual(["start:A", "end:A", "start:B", "end:B", "start:C", "end:C"]);
		expect(results.map(result => result.status)).toEqual(["completed", "completed", "completed"]);
	});

	test("executes a diamond dependency with parallel middle tasks", async () => {
		const events: string[] = [];
		let active = 0;
		let maxActive = 0;
		const track = async (id: string, delayMs: number): Promise<string> => {
			active++;
			maxActive = Math.max(maxActive, active);
			events.push(`start:${id}`);
			await Bun.sleep(delayMs);
			events.push(`end:${id}`);
			active--;
			return id;
		};

		await scheduleBatch(
			[
				{ id: "A", run: async () => track("A", 5) },
				{ id: "B", blockers: ["A"], run: async () => track("B", 20) },
				{ id: "C", blockers: ["A"], run: async () => track("C", 20) },
				{ id: "D", blockers: ["B", "C"], run: async () => track("D", 1) },
			],
			{ maxConcurrency: 2 },
		);

		expect(events.indexOf("end:A")).toBeLessThan(events.indexOf("start:B"));
		expect(events.indexOf("end:A")).toBeLessThan(events.indexOf("start:C"));
		expect(events.indexOf("end:B")).toBeLessThan(events.indexOf("start:D"));
		expect(events.indexOf("end:C")).toBeLessThan(events.indexOf("start:D"));
		expect(maxActive).toBe(2);
	});

	test("rejects missing blocker references before dispatch", async () => {
		const started: string[] = [];
		await expect(
			scheduleBatch(
				[
					{
						id: "A",
						run: async () => {
							started.push("A");
							return "A";
						},
					},
					{ id: "B", blockers: ["missing"], run: async () => "B" },
				],
				{ maxConcurrency: 2 },
			),
		).rejects.toThrow("Task B depends on missing blocker missing");
		expect(started).toEqual([]);
	});

	test("rejects dependency cycles before dispatch", async () => {
		await expect(
			scheduleBatch(
				[
					{ id: "A", blockers: ["B"], run: async () => "A" },
					{ id: "B", blockers: ["A"], run: async () => "B" },
				],
				{ maxConcurrency: 2 },
			),
		).rejects.toThrow("Task batch contains dependency cycles");
	});

	test("marks dependents failed when a predecessor fails", async () => {
		const results = await scheduleBatch(
			[
				{
					id: "A",
					run: async () => {
						throw new Error("boom");
					},
				},
				{ id: "B", blockers: ["A"], run: async () => "B" },
				{ id: "C", blockers: ["B"], run: async () => "C" },
			],
			{ maxConcurrency: 2 },
		);

		expect(results).toEqual([
			{ id: "A", status: "failed", error: "boom" },
			{ id: "B", status: "failed", error: "Predecessor A failed" },
			{ id: "C", status: "failed", error: "Predecessor A failed" },
		]);
	});

	test("allows independent branches to continue after a failure", async () => {
		const results = await scheduleBatch(
			[
				{
					id: "A",
					run: async () => {
						throw new Error("boom");
					},
				},
				{ id: "B", blockers: ["A"], run: async () => "B" },
				{ id: "C", run: async () => "C" },
				{ id: "D", blockers: ["C"], run: async () => "D" },
			],
			{ maxConcurrency: 2 },
		);

		expect(results).toEqual([
			{ id: "A", status: "failed", error: "boom" },
			{ id: "B", status: "failed", error: "Predecessor A failed" },
			{ id: "C", status: "completed", result: "C" },
			{ id: "D", status: "completed", result: "D" },
		]);
	});

	test("respects maxConcurrency for ready tasks", async () => {
		let active = 0;
		let maxActive = 0;
		const gates = [deferred(), deferred(), deferred(), deferred()];
		const schedulerPromise = scheduleBatch(
			gates.map(
				(gate, index) =>
					({
						id: `T${index + 1}`,
						run: async () => {
							active++;
							maxActive = Math.max(maxActive, active);
							await gate.promise;
							active--;
							return index;
						},
					}) satisfies BatchTask<number>,
			),
			{ maxConcurrency: 2 },
		);

		await Bun.sleep(10);
		expect(maxActive).toBe(2);
		for (const gate of gates) {
			gate.resolve();
		}
		await schedulerPromise;
	});

	test("aborts pending work without dispatching new tasks", async () => {
		const controller = new AbortController();
		const started: string[] = [];
		const running = deferred();
		const resultsPromise = scheduleBatch(
			[
				{
					id: "A",
					run: async signal => {
						started.push("A");
						await Promise.race([
							running.promise,
							new Promise<never>((_, reject) => {
								signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
							}),
						]);
						return "A";
					},
				},
				{ id: "B", blockers: ["A"], run: async () => "B" },
				{
					id: "C",
					run: async () => {
						started.push("C");
						return "C";
					},
				},
			],
			{ maxConcurrency: 1, signal: controller.signal },
		);

		await Bun.sleep(10);
		controller.abort();
		const results = await resultsPromise;

		expect(started).toEqual(["A"]);
		expect(results).toEqual([
			{ id: "A", status: "aborted", error: "aborted" },
			{ id: "B", status: "aborted", error: "Cancelled before start" },
			{ id: "C", status: "aborted", error: "Cancelled before start" },
		]);
	});

	test("returns immediately for an empty batch", async () => {
		expect(await scheduleBatch([], { maxConcurrency: 4 })).toEqual([]);
	});

	test("buildBatchGraph preserves valid topological ordering", () => {
		const graph = buildBatchGraph([
			{ id: "A" },
			{ id: "B", blockers: ["A"] },
			{ id: "C", blockers: ["A"] },
			{ id: "D", blockers: ["B", "C"] },
		]);

		expect(graph.order[0]).toBe("A");
		expect(graph.order.at(-1)).toBe("D");
	});
});
