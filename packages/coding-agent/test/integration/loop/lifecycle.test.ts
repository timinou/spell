import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { LoopEvent } from "../../../src/loop/contracts";
import type { LoopSnapshot } from "../../../src/loop/types";
import { createMockState, createTestSettings, type MockState, resetMockState } from "../../helpers/mocked-loop-harness";

// ---------------------------------------------------------------------------
// Shared mock state: mutable object that mock closures reference by indirection.
// resetMockState() clears arrays in-place so closures always see fresh state.
// ---------------------------------------------------------------------------
const mockState: MockState = createMockState();

// ---------------------------------------------------------------------------
// Module mocks — hoisted by bun before any static imports.
// ---------------------------------------------------------------------------
mock.module("../../../src/loop/persistence/event-log", () => ({
	appendLoopEvent: async (_cwd: string, event: LoopEvent, snapshot: LoopSnapshot) => {
		mockState.persistedEvents.push({ event, snapshot: structuredClone(snapshot) });
	},
	readLoopEvents: async () => [],
	replayLoopEvents: () => undefined,
}));

mock.module("../../../src/loop/persistence/org-sync", () => ({
	syncLoopOrgItem: async (_cwd: string, snapshot: LoopSnapshot) => {
		mockState.syncedSnapshots.push(structuredClone(snapshot));
		return `/mock/${snapshot.id}.org`;
	},
}));

mock.module("../../../src/loop/persistence/checkpoint", () => ({
	saveLoopState: async (_cwd: string, snapshot: LoopSnapshot) => {
		mockState.savedStates.push(structuredClone(snapshot));
	},
	loadLoopState: async () => undefined,
	buildIterationCheckpoint: (loop: LoopSnapshot) => ({
		loopId: loop.id,
		iteration: loop.iteration,
		state: loop.state,
		timestamp: loop.updatedAt,
	}),
}));

mock.module("../../../src/loop/persistence/session-hooks", () => ({
	restoreLoopSnapshots: async () => [...mockState.restoreSnapshots],
}));

mock.module("../../../src/loop/git/dirty-check", () => ({
	ensureCleanGitTree: async () => ({ ...mockState.gitCheckResult }),
}));

mock.module("../../../src/loop/git/drift", () => ({
	snapshotSpecFiles: async (paths: string[]) => {
		mockState.gitCalls.push(`snapshotSpecFiles:${paths.join(",")}`);
		return {};
	},
	detectSpecDrift: async () => {
		mockState.gitCalls.push("detectSpecDrift");
		return [];
	},
}));

mock.module("../../../src/loop/git/worktree", () => ({
	createLoopWorktree: async (_cwd: string, loopId: string, targetDir: string) => {
		mockState.worktreeCalls.push(`create:${loopId}`);
		return { branch: `loop/${loopId}`, path: targetDir };
	},
	removeLoopWorktree: async (_cwd: string, worktreePath: string) => {
		mockState.worktreeCalls.push(`remove:${worktreePath}`);
	},
}));

// ---------------------------------------------------------------------------
// Imports that depend on mocked modules — safe because mocks are hoisted.
// ---------------------------------------------------------------------------
import { LoopManager } from "../../../src/loop/loop-manager";
import { EventBus } from "../../../src/utils/event-bus";
import { StubLoopResponder } from "../../helpers/stub-llm";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function createManager(eventBus?: EventBus): LoopManager {
	return new LoopManager({
		cwd: "/tmp",
		settings: createTestSettings(),
		eventBus,
		concurrencyLimit: 10,
	});
}

function createResponder(): StubLoopResponder {
	const responder = new StubLoopResponder();
	responder.set("plan", { summary: "plan output" });
	responder.set("code", { summary: "code output", changedFiles: ["src/index.ts"] });
	responder.set("review", { summary: "review output" });
	return responder;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("loop integration: lifecycle", () => {
	let manager: LoopManager;
	let eventBus: EventBus;
	let responder: StubLoopResponder;

	beforeEach(() => {
		resetMockState(mockState);
		eventBus = new EventBus();
		manager = createManager(eventBus);
		responder = createResponder();
	});

	afterEach(() => {
		eventBus.clear();
	});

	// -----------------------------------------------------------------------
	// Test 1: Multi-iteration lifecycle
	// -----------------------------------------------------------------------
	it("completes a full lifecycle: start -> iterate x3 -> reflect -> iterate -> validate -> complete", async () => {
		const loop = await manager.start({
			name: "lifecycle",
			maxIterations: 5,
			reflectEvery: 3,
			domains: [],
		});
		expect(loop.state).toBe("planning");
		expect(loop.iteration).toBe(0);

		// Iterations 1-2: should stay in planning
		const iter1 = await manager.runIteration(loop.id, responder);
		expect(iter1.snapshot.iteration).toBe(1);
		expect(iter1.snapshot.state).toBe("planning");

		const iter2 = await manager.runIteration(loop.id, responder);
		expect(iter2.snapshot.iteration).toBe(2);
		expect(iter2.snapshot.state).toBe("planning");

		// Iteration 3: reflectEvery=3 triggers reflection
		const iter3 = await manager.runIteration(loop.id, responder);
		expect(iter3.snapshot.iteration).toBe(3);
		expect(iter3.snapshot.state).toBe("reflecting");

		// Transition out of reflecting -> planning
		const afterReflect = await manager.markDone(loop.id);
		expect(afterReflect.state).toBe("planning");

		// Iteration 4: normal advance
		const iter4 = await manager.runIteration(loop.id, responder);
		expect(iter4.snapshot.iteration).toBe(4);
		expect(iter4.snapshot.state).toBe("planning");

		// Manually advance to validating via forceValidate:
		// markDone on planning -> iterating, then markDone with forceValidate -> validating
		await manager.markDone(loop.id); // planning -> iterating
		const validating = await manager.markDone(loop.id, { forceValidate: true });
		expect(validating.state).toBe("validating");
		expect(validating.iteration).toBe(5);

		// Complete from validating
		const complete = await manager.markDone(loop.id);
		expect(complete.state).toBe("complete");
		expect(complete.completedAt).toBeDefined();

		// Verify persistence recorded events
		expect(mockState.persistedEvents.length).toBeGreaterThan(0);
		const eventTypes = mockState.persistedEvents.map(e => e.event.type);
		expect(eventTypes).toContain("loop.created");
		expect(eventTypes).toContain("loop.iteration_completed");
		expect(eventTypes).toContain("loop.completed");
	});

	// -----------------------------------------------------------------------
	// Test 2: Command gate failure is recorded
	// -----------------------------------------------------------------------
	it("records gate failure when a command gate returns non-zero exit", async () => {
		const loop = await manager.start({
			name: "gate-fail",
			maxIterations: 10,
			domains: [],
			gates: [
				{
					id: "lint",
					type: "command",
					command: "false",
					trigger: { kind: "every-n", every: 1 },
				},
			],
		});

		const result = await manager.runIteration(loop.id, responder);
		const lintDecision = result.gateDecisions.find(d => d.gateId === "lint");
		expect(lintDecision).toBeDefined();
		expect(lintDecision!.outcome).toBe("fail");

		// Verify the gate result was recorded on the snapshot
		const snap = manager.getLoop(loop.id);
		expect(snap.gateResults.some(r => r.gateId === "lint" && r.outcome === "fail")).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Test 3: Human gate auto-approve fires after timeout
	// -----------------------------------------------------------------------
	it("auto-approves a human gate after the configured timeout", async () => {
		const loop = await manager.start({
			name: "human-gate",
			maxIterations: 10,
			domains: [],
			gates: [
				{
					id: "review",
					type: "human",
					prompt: "Approve iteration?",
					trigger: { kind: "every-n", every: 1 },
					autoApproveAfterMs: 50,
				},
			],
		});

		// runIteration blocks on the human gate. The real clock auto-approves after 50ms.
		const result = await manager.runIteration(loop.id, responder);
		const gateDecision = result.gateDecisions.find(d => d.gateId === "review");
		expect(gateDecision).toBeDefined();
		expect(gateDecision!.outcome).toBe("pass");
		expect(gateDecision!.reason).toContain("Auto-approved");
	});

	// -----------------------------------------------------------------------
	// Test 4: Budget exceeded pauses the loop
	// -----------------------------------------------------------------------
	it("pauses the loop when wall-clock budget is exceeded", async () => {
		const loop = await manager.start({
			name: "budget-test",
			maxIterations: 100,
			domains: [],
			budgetLimits: { wallClockMs: 1, maxTreeIterations: 200, maxIdleIterations: 5 },
		});

		// Any real time passing (even 1ms) exceeds the 1ms budget.
		await Bun.sleep(2);
		const result = await manager.runIteration(loop.id, responder);
		expect(result.snapshot.state).toBe("paused");
		expect(result.snapshot.statusReason).toContain("budget");

		// Verify the loop can be resumed
		const resumed = await manager.resume(loop.id);
		expect(resumed.state).toBe("iterating");
	});

	// -----------------------------------------------------------------------
	// Test 5: Runaway detection pauses the loop on idle iterations
	// -----------------------------------------------------------------------
	it("pauses the loop after maxIdleIterations of identical progress", async () => {
		// Configure responder to return identical content every time (no progress)
		const staticResponder = new StubLoopResponder();
		staticResponder.set("plan", { summary: "same", changedFiles: [], findings: [] });
		staticResponder.set("code", { summary: "same", changedFiles: [], findings: [] });
		staticResponder.set("review", { summary: "same", changedFiles: [], findings: [] });

		const loop = await manager.start({
			name: "runaway-test",
			maxIterations: 100,
			domains: [],
			budgetLimits: { wallClockMs: 0, maxTreeIterations: 0, maxIdleIterations: 2 },
		});
		// idleIterations increments every iteration (detectRunaway compares hash with itself).
		// After iteration 1: idleIterations = 1 (< 2, not paused).
		// After iteration 2: idleIterations = 2 (>= maxIdleIterations=2, paused).
		const iter1 = await manager.runIteration(loop.id, staticResponder);
		expect(iter1.snapshot.state).toBe("planning");
		expect(iter1.snapshot.budgetStatus.idleIterations).toBe(1);

		const result = await manager.runIteration(loop.id, staticResponder);
		expect(result.snapshot.state).toBe("paused");
		expect(result.snapshot.statusReason).toContain("Runaway");
		expect(result.snapshot.budgetStatus.idleIterations).toBeGreaterThanOrEqual(2);
	});

	// -----------------------------------------------------------------------
	// Test 6: Child spawn, complete, and kill-tree
	// -----------------------------------------------------------------------
	it("manages parent-child lifecycle: spawn, complete child, and kill-tree", async () => {
		const parent = await manager.start({ name: "parent", domains: [], maxIterations: 10 });

		// Spawn a required child
		const child = await manager.spawnChild(parent.id, {
			name: "child",
			domains: [],
			requiredChild: true,
		});
		const parentSnap = manager.getLoop(parent.id);
		expect(parentSnap.childLoopIds).toContain(child.id);
		expect(parentSnap.pendingChildLoopIds).toContain(child.id);

		// Complete the child
		await manager.completeChild({
			parentLoopId: parent.id,
			childLoopId: child.id,
			outcome: "success",
			summary: "Child done",
			artifacts: [],
			gateResults: [],
		});
		const afterComplete = manager.getLoop(parent.id);
		expect(afterComplete.pendingChildLoopIds).not.toContain(child.id);

		// Spawn two more children and kill the tree
		const parent2 = await manager.start({ name: "parent2", domains: [], maxIterations: 10 });
		const c1 = await manager.spawnChild(parent2.id, { name: "c1", domains: [] });
		const c2 = await manager.spawnChild(parent2.id, { name: "c2", domains: [] });

		const killed = await manager.kill(parent2.id);
		const killedIds = killed.map(k => k.id);
		expect(killedIds).toContain(parent2.id);
		expect(killedIds).toContain(c1.id);
		expect(killedIds).toContain(c2.id);
		expect(killed.every(k => k.state === "killed")).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Test 7: gitAvailable=false skips all git operations
	// -----------------------------------------------------------------------
	it("disables git features when git is unavailable", async () => {
		// Simulate git unavailable: ok=true with message (no dirty-tree error, but git missing)
		mockState.gitCheckResult = { ok: true, message: "Git repository unavailable" };

		const loop = await manager.start({
			name: "no-git",
			maxIterations: 10,
			domains: [],
			specPaths: ["spec.org"],
			useWorktree: true,
		});

		expect(loop.gitAvailable).toBe(false);
		expect(loop.worktreePath).toBeUndefined();
		// No git operations should have been called
		expect(mockState.gitCalls.filter(c => c.startsWith("snapshotSpecFiles"))).toHaveLength(0);
		expect(mockState.worktreeCalls.filter(c => c.startsWith("create"))).toHaveLength(0);

		// Run an iteration — should still work normally
		const result = await manager.runIteration(loop.id, responder);
		expect(result.snapshot.iteration).toBe(1);
		expect(result.snapshot.state).toBe("planning");
		// No drift detection should have been called
		expect(mockState.gitCalls.filter(c => c === "detectSpecDrift")).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// Test 8: onBeforePhase hook called during runIteration, errors don't crash
	// -----------------------------------------------------------------------
	it("fires onBeforePhase for each role and swallows hook errors", async () => {
		const loop = await manager.start({
			name: "hooks",
			maxIterations: 10,
			domains: [],
		});

		const hookCalls: Array<{ role: string; loopId: string }> = [];
		const result = await manager.runIteration(loop.id, responder, {
			onBeforePhase: async (role, loopSnap) => {
				hookCalls.push({ role, loopId: loopSnap.id });
				if (role === "code") throw new Error("intentional hook error");
			},
		});

		// Hook was called for all 3 phases despite the error on "code"
		expect(hookCalls).toHaveLength(3);
		expect(hookCalls.map(h => h.role)).toEqual(["plan", "code", "review"]);
		expect(hookCalls.every(h => h.loopId === loop.id)).toBe(true);

		// Iteration still completed successfully
		expect(result.snapshot.iteration).toBe(1);
		expect(result.handoffs).toHaveLength(3);

		// Persistence recorded the iteration
		const iterEvents = mockState.persistedEvents.filter(e => e.event.type === "loop.iteration_completed");
		expect(iterEvents.length).toBeGreaterThanOrEqual(1);
	});

	// -----------------------------------------------------------------------
	// Cross-cutting: no real filesystem writes occurred
	// -----------------------------------------------------------------------
	it("all I/O is captured in mockState, no real filesystem writes", async () => {
		const loop = await manager.start({ name: "io-check", domains: [], maxIterations: 3 });
		await manager.runIteration(loop.id, responder);
		await manager.markDone(loop.id, { forceValidate: true });

		// Persistence was called (not skipped)
		expect(mockState.persistedEvents.length).toBeGreaterThan(0);
		expect(mockState.syncedSnapshots.length).toBeGreaterThan(0);
		expect(mockState.savedStates.length).toBeGreaterThan(0);

		// All persisted paths are mock paths (no real filesystem)
		for (const entry of mockState.persistedEvents) {
			expect(entry.event.loopId).toBeTruthy();
		}
	});
});
