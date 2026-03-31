import { describe, expect, it } from "bun:test";
import { TICKET_STATES } from "../../src/loop/contracts";
import { buildIterationPrompt, buildManifestPromptContext, buildReflectionPrompt } from "../../src/loop/prompt-builder";
import type { LoopSnapshot, ManifestSnapshot, ManifestTicket } from "../../src/loop/types";

function makeTicket(overrides: Partial<ManifestTicket> & { id: string }): ManifestTicket {
	return {
		title: overrides.id,
		state: TICKET_STATES.item,
		acceptanceCriteria: [],
		dependencies: [],
		triggers: [],
		gates: [],
		tags: [],
		changedFiles: [],
		findings: [],
		iterationHistory: [],
		...overrides,
	};
}

function makeManifest(tickets: ManifestTicket[]): ManifestSnapshot {
	return {
		version: 1,
		tickets,
		dependencyEdges: [],
		triggerRules: [],
		manifestOrgPath: "",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeSnapshot(overrides?: Partial<LoopSnapshot>): LoopSnapshot {
	return {
		id: "test-loop",
		name: "test",
		state: "iterating",
		iteration: 1,
		maxIterations: 10,
		depth: 0,
		orgItemId: "test-loop",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		startedAt: Date.now(),
		currentRole: "plan",
		reflectEvery: 3,
		taskFileHash: "",
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
		budgetLimits: { wallClockMs: 3600000, maxTreeIterations: 100, maxIdleIterations: 5 },
		budgetStatus: { elapsedMs: 0, treeIterations: 0, idleIterations: 0 },
		totalTreeIterations: 0,
		specPaths: [],
		domainNames: [],
		lastProgressHash: "",
		autoApproveEnabled: true,
		reviewModelConfigured: false,
		gitAvailable: true,
		...overrides,
	};
}

describe("buildManifestPromptContext", () => {
	it("returns populated fields when manifest exists", () => {
		const manifest = makeManifest([
			makeTicket({ id: "T-001", state: TICKET_STATES.done }),
			makeTicket({ id: "T-002", state: TICKET_STATES.doing, dependencies: ["T-001"] }),
			makeTicket({ id: "T-003", state: TICKET_STATES.item }),
		]);
		const snapshot = makeSnapshot({ manifest });

		const ctx = buildManifestPromptContext(snapshot);

		expect(ctx.manifestTickets).toHaveLength(3);
		expect(ctx.manifestProgress).toContain("1/3 done");
		expect(ctx.completedTickets).toContain("T-001");
		expect(ctx.activeTickets).toContain("T-002");
		expect(ctx.readyTickets).toContain("T-003");
		expect(ctx.manifestComplete).toBe(false);
	});

	it("returns empty object when no manifest", () => {
		const snapshot = makeSnapshot();

		const ctx = buildManifestPromptContext(snapshot);

		expect(ctx).toEqual({});
	});
});

describe("buildIterationPrompt with manifest context", () => {
	it("renders ticket table when manifest context is provided", () => {
		const manifest = makeManifest([
			makeTicket({ id: "T-001", state: TICKET_STATES.item, priority: "#A" }),
			makeTicket({ id: "T-002", state: TICKET_STATES.doing }),
		]);
		const snapshot = makeSnapshot({ manifest });
		const manifestCtx = buildManifestPromptContext(snapshot);

		const prompt = buildIterationPrompt({
			loopId: "test-loop",
			name: "test",
			iteration: 1,
			state: "iterating",
			changedFiles: [],
			openFindings: [],
			pendingGates: [],
			...manifestCtx,
		});

		expect(prompt).toContain("T-001");
		expect(prompt).toContain("T-002");
		expect(prompt).toContain("Manifest Status");
	});

	it("does not render manifest section without manifest context", () => {
		const prompt = buildIterationPrompt({
			loopId: "test-loop",
			name: "test",
			iteration: 1,
			state: "iterating",
			changedFiles: [],
			openFindings: [],
			pendingGates: [],
		});

		expect(prompt).not.toContain("Manifest Status");
	});
});

describe("buildReflectionPrompt with manifest context", () => {
	it("renders manifest reflection section", () => {
		const manifest = makeManifest([
			makeTicket({ id: "T-001", state: TICKET_STATES.done }),
			makeTicket({ id: "T-002", state: TICKET_STATES.item }),
		]);
		const snapshot = makeSnapshot({ manifest });
		const manifestCtx = buildManifestPromptContext(snapshot);

		const prompt = buildReflectionPrompt({
			loopId: "test-loop",
			name: "test",
			iteration: 1,
			state: "reflecting",
			changedFiles: [],
			openFindings: [],
			pendingGates: [],
			...manifestCtx,
		});

		expect(prompt).toContain("Manifest Reflection");
		expect(prompt).toContain("1/2 done");
	});
});
