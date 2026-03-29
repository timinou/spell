import { describe, expect, it } from "bun:test";
import { HumanGateExecutor } from "../../src/loop/gates/executors/human";
import { GateTimer } from "../../src/loop/gates/timer";
import type { LoopSnapshot } from "../../src/loop/types";
import { VirtualClock } from "../helpers/virtual-clock";

describe("GateTimer", () => {
	it("fires, cancels, and resets using the virtual clock", () => {
		const clock = new VirtualClock();
		let fired = 0;
		const timer = new GateTimer(clock, 100, () => {
			fired += 1;
		});
		timer.start();
		clock.advance(99);
		expect(fired).toBe(0);
		clock.advance(1);
		expect(fired).toBe(1);

		timer.start();
		timer.cancel();
		clock.advance(100);
		expect(fired).toBe(1);

		timer.reset(50);
		clock.advance(49);
		expect(fired).toBe(1);
		clock.advance(1);
		expect(fired).toBe(2);
	});
});

describe("HumanGateExecutor settings integration", () => {
	it("uses configured timeout from settings instead of constant", async () => {
		const clock = new VirtualClock();
		const executor = new HumanGateExecutor(clock, {
			getAutoApproveTimeoutMs: () => 200,
			getAutoApproveEnabled: () => true,
		});
		// Create a minimal context
		const loop: LoopSnapshot = {
			id: "LOOP-T",
			name: "timer-test",
			state: "iterating",
			iteration: 1,
			maxIterations: 10,
			depth: 0,
			orgItemId: "LOOP-T",
			createdAt: 0,
			updatedAt: 0,
			startedAt: 0,
			currentRole: "plan",
			reflectEvery: 3,
			taskFileHash: "h",
			changedFiles: [],
			openFindings: [],
			childLoopIds: [],
			requiredChildLoopIds: [],
			pendingChildLoopIds: [],
			pendingGates: [],
			gateConfigs: [],
			gateResults: [],
			checkpoints: [],
			handoffs: [],
			budgetLimits: { wallClockMs: 1000, maxTreeIterations: 10, maxIdleIterations: 5 },
			budgetStatus: { elapsedMs: 0, treeIterations: 0, idleIterations: 0 },
			totalTreeIterations: 0,
			specPaths: [],
			domainNames: [],
			lastProgressHash: "h",
			autoApproveEnabled: true,
			reviewModelConfigured: true,
			gitAvailable: true,
		};
		const gate = {
			id: "gate-1",
			type: "human" as const,
			prompt: "Approve?",
			trigger: { kind: "every-iteration" as const },
		};
		// Start execution (it will block on the promise)
		const resultPromise = executor.execute(gate, { loop, attemptNumber: 1, evidence: [], cwd: "/tmp" });
		// Advance clock to just before the configured 200ms timeout
		clock.advance(199);
		const pending = executor.listPending("LOOP-T");
		expect(pending).toHaveLength(1);
		// Advance past the 200ms timeout - should auto-approve
		clock.advance(1);
		const result = await resultPromise;
		expect(result.outcome).toBe("pass");
		expect(result.reason).toContain("Auto-approved");
	});
});
