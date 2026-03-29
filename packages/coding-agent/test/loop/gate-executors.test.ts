import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ArtifactGateExecutor,
	CommandGateExecutor,
	HumanGateExecutor,
	LlmReviewGateExecutor,
} from "../../src/loop/gates/executors";
import type { LoopSnapshot } from "../../src/loop/types";
import { VirtualClock } from "../helpers/virtual-clock";

function createLoop(): LoopSnapshot {
	return {
		id: "LOOP-1",
		name: "demo",
		state: "iterating",
		iteration: 1,
		maxIterations: 3,
		depth: 0,
		orgItemId: "LOOP-1",
		createdAt: 0,
		updatedAt: 0,
		startedAt: 0,
		currentRole: "plan",
		reflectEvery: 3,
		taskFileHash: "hash",
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
		lastProgressHash: "hash",
		autoApproveEnabled: true,
		reviewModelConfigured: true,
		gitAvailable: true,
	};
}

describe("gate executors", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-gates-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("passes and fails command gates with timeout handling", async () => {
		const executor = new CommandGateExecutor();
		const pass = await executor.execute(
			{ id: "pass", type: "command", trigger: { kind: "every-iteration" }, command: "printf ok" },
			{ cwd, loop: createLoop(), attemptNumber: 1 },
		);
		expect(pass.outcome).toBe("pass");
		const fail = await executor.execute(
			{ id: "fail", type: "command", trigger: { kind: "every-iteration" }, command: "echo boom >&2; exit 2" },
			{ cwd, loop: createLoop(), attemptNumber: 1 },
		);
		expect(fail.outcome).toBe("fail");
		const timeout = await executor.execute(
			{ id: "timeout", type: "command", trigger: { kind: "every-iteration" }, command: "sleep 1", timeoutMs: 10 },
			{ cwd, loop: createLoop(), attemptNumber: 1 },
		);
		expect(timeout.reason).toContain("timed out");
	});

	it("uses reviewer responses for llm-review gates", async () => {
		const reviewer = {
			async review() {
				return { pass: false, summary: "needs changes", findings: ["missing tests"] };
			},
		};
		const executor = new LlmReviewGateExecutor(reviewer);
		const result = await executor.execute(
			{ id: "review", type: "llm-review", trigger: { kind: "on-reflection" }, criteria: "review" },
			{ cwd, loop: createLoop(), attemptNumber: 1 },
		);
		expect(result.outcome).toBe("fail");
		expect(result.evidence).toEqual(["missing tests"]);
	});

	it("checks artifact presence and regex validation", async () => {
		const executor = new ArtifactGateExecutor();
		await Bun.write(path.join(cwd, "artifact.txt"), "hello world");
		const present = await executor.execute(
			{ id: "artifact", type: "artifact", trigger: { kind: "on-completion" }, path: "artifact.txt", regex: "hello" },
			{ cwd, loop: createLoop(), attemptNumber: 1 },
		);
		expect(present.outcome).toBe("pass");
		const missing = await executor.execute(
			{ id: "missing", type: "artifact", trigger: { kind: "on-completion" }, path: "missing.txt" },
			{ cwd, loop: createLoop(), attemptNumber: 1 },
		);
		expect(missing.outcome).toBe("fail");
	});

	it("supports human gate approve, reject, and auto-approve", async () => {
		const clock = new VirtualClock();
		const executor = new HumanGateExecutor(clock);
		const autoApprovePromise = executor.execute(
			{
				id: "human-auto",
				type: "human",
				trigger: { kind: "on-completion" },
				prompt: "Approve?",
				autoApproveAfterMs: 100,
			},
			{ cwd, loop: createLoop(), attemptNumber: 1 },
		);
		clock.advance(100);
		expect((await autoApprovePromise).outcome).toBe("pass");

		const approvePromise = executor.execute(
			{
				id: "human-approve",
				type: "human",
				trigger: { kind: "on-completion" },
				prompt: "Approve?",
				autoApproveAfterMs: 0,
			},
			{ cwd, loop: createLoop(), attemptNumber: 1 },
		);
		executor.approve("LOOP-1", "human-approve");
		expect((await approvePromise).outcome).toBe("pass");

		const rejectPromise = executor.execute(
			{
				id: "human-reject",
				type: "human",
				trigger: { kind: "on-completion" },
				prompt: "Approve?",
				autoApproveAfterMs: 0,
			},
			{ cwd, loop: createLoop(), attemptNumber: 1 },
		);
		executor.reject("LOOP-1", "human-reject");
		expect((await rejectPromise).outcome).toBe("fail");
	});
});
