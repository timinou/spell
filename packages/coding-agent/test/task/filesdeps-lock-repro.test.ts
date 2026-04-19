// Repro for table row A ("No file-level lock between concurrent subagents").
//
// Session 2026-04-19T08-55-28-607Z_14c08a4197c6a60b ran 4 top-level task
// subagents concurrently with `isolated:false` (tree isolation disabled
// because task.isolation.mode was "none"). All 4 shared a live working
// tree. Feat588's HookPlanBoundarySnapshot subagent issued a `write` on
// packages/coding-agent/src/tools/todo-write.ts at 09:22:47Z while
// Feat587's subagent was verifying changes to the same area.
//
// `filesDeps` was present on every task but the scheduler only consulted
// it under `isolationMode=true`. With isolation disabled, the scheduler's
// `canRun()` returns true unconditionally and overlapping filesDeps do
// not serialize — which is how Feat588 wrote todo-write.ts while Feat587
// was mid-verify.
//
// Contract asserted here: two task-level nodes that declare overlapping
// `filesDeps` MUST NOT be in-flight at the same time, regardless of
// whether tree-level isolation is on. File-level mutual exclusion is
// independent of worktree/overlay isolation.
import { describe, expect, test } from "bun:test";
import { SwarmScheduler } from "@oh-my-pi/pi-coding-agent/task/swarm-scheduler";

interface NodeLike {
	kind?: "work";
	status?: "pending" | "in_progress" | "completed" | "failed" | "aborted" | "gate_failed" | "abandoned";
	filesDeps?: string[];
}

function node(filesDeps?: string[]): NodeLike {
	return { kind: "work", status: "pending", filesDeps };
}

// Helper that returns a runner + a way to step tasks through (gate,release).
// Runner increments inFlight on entry, waits for release, decrements on exit.
function instrumentedRunner(maxSeen: { value: number }) {
	let inFlight = 0;
	const gates = new Map<string, { enter: Promise<void>; release: () => void; done: () => void }>();
	const ensure = (id: string) => {
		let g = gates.get(id);
		if (!g) {
			const enter = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			g = {
				enter: enter.promise,
				release: () => release.resolve(),
				done: () => enter.resolve(),
			};
			// keep release promise awaitable inside runner
			(g as typeof g & { _releasePromise: Promise<void> })._releasePromise = release.promise;
			gates.set(id, g);
		}
		return g;
	};
	const runner = async (id: string) => {
		const g = ensure(id);
		inFlight++;
		maxSeen.value = Math.max(maxSeen.value, inFlight);
		g.done();
		await (g as typeof g & { _releasePromise: Promise<void> })._releasePromise;
		inFlight--;
	};
	const hasEntered = (id: string) => ensure(id).enter;
	const release = (id: string) => ensure(id).release();
	return { runner, hasEntered, release };
}

describe("filesDeps lock (RED while scheduler ignores overlap without isolationMode)", () => {
	test("two nodes with overlapping filesDeps must not be in-flight simultaneously", async () => {
		const scheduler = new SwarmScheduler<NodeLike>(
			[
				["A", node(["packages/coding-agent/src/tools/todo-write.ts"])],
				["B", node(["packages/coding-agent/src/tools/todo-write.ts"])],
			],
			{ maxConcurrency: 4, isolationMode: false },
		);

		const maxSeen = { value: 0 };
		const { runner, hasEntered, release } = instrumentedRunner(maxSeen);

		// Drive pump concurrently with gate control.
		const pumped = scheduler.pump(async id => {
			await runner(id);
			scheduler.markCompleted(id);
		});

		// Wait a tick — if both enter, we'd see both gates resolve.
		// Wait for A to enter the runner.
		await hasEntered("A");
		// Give scheduler an extra tick to (potentially incorrectly) admit B.
		await Bun.sleep(30);
		// Release A; then B should enter.
		release("A");
		await hasEntered("B");
		release("B");

		await pumped;

		// Contract: overlapping filesDeps ⇒ serial.
		expect(maxSeen.value).toBe(1);
	});

	test("two nodes with disjoint filesDeps may run in parallel", async () => {
		const scheduler = new SwarmScheduler<NodeLike>(
			[
				["A", node(["packages/coding-agent/src/tools/todo-write.ts"])],
				["B", node(["packages/coding-agent/src/tools/write.ts"])],
			],
			{ maxConcurrency: 4, isolationMode: false },
		);

		const maxSeen = { value: 0 };
		const { runner, hasEntered, release } = instrumentedRunner(maxSeen);

		const pumped = scheduler.pump(async id => {
			await runner(id);
			scheduler.markCompleted(id);
		});

		await hasEntered("A");
		await hasEntered("B");
		// Both are running simultaneously now.
		release("A");
		release("B");

		await pumped;

		expect(maxSeen.value).toBe(2);
	});

	test("a node without filesDeps is conservative — serializes against anything in flight", async () => {
		const scheduler = new SwarmScheduler<NodeLike>(
			[
				["A", node(["packages/coding-agent/src/tools/todo-write.ts"])],
				["B", node()], // unscoped — must not race against scoped writers
			],
			{ maxConcurrency: 4, isolationMode: false },
		);

		const maxSeen = { value: 0 };
		const { runner, hasEntered, release } = instrumentedRunner(maxSeen);

		const pumped = scheduler.pump(async id => {
			await runner(id);
			scheduler.markCompleted(id);
		});

		await hasEntered("A");
		await Bun.sleep(30);
		release("A");
		await hasEntered("B");
		release("B");

		await pumped;

		expect(maxSeen.value).toBe(1);
	});
});
