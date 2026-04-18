import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GATE_TRIGGERS, TICKET_STATES } from "../../src/loop/contracts";
import { readManifest } from "../../src/loop/persistence/manifest-reader";
import { writeManifest } from "../../src/loop/persistence/manifest-writer";
import type { ManifestSnapshot, ManifestTicket } from "../../src/loop/types";

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

let tmpDir: string;
beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-rt-"));
});
afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("manifest round-trip", () => {
	const loopId = "test-loop";
	const loopName = "Test Loop";

	it("edge direction: from=blocker, to=dependent", async () => {
		const a = makeTicket({ id: "A", dependencies: ["B"] });
		const b = makeTicket({ id: "B" });
		const manifest = makeManifest([a, b]);

		await writeManifest(tmpDir, loopId, loopName, manifest);
		const result = await readManifest(tmpDir, loopId);

		expect(result).toBeDefined();
		expect(result!.dependencyEdges).toContainEqual({ from: "B", to: "A" });
	});

	it("identity fields preserved", async () => {
		const ticket = makeTicket({
			id: "T1",
			orgItemId: "org-1",
			childLoopId: "child-1",
			iterationHistory: [1, 3, 5],
			changedFiles: ["a.ts"],
			findings: ["found issue"],
		});
		const manifest = makeManifest([ticket]);

		await writeManifest(tmpDir, loopId, loopName, manifest);
		const result = await readManifest(tmpDir, loopId);

		const t = result!.tickets.find(t => t.id === "T1");
		expect(t).toBeDefined();
		expect(t!.orgItemId).toBe("org-1");
		expect(t!.childLoopId).toBe("child-1");
		expect(t!.iterationHistory).toEqual([1, 3, 5]);
		expect(t!.changedFiles).toEqual(["a.ts"]);
		expect(t!.findings).toEqual(["found issue"]);
	});

	it("tags preserved", async () => {
		const ticket = makeTicket({ id: "T2", tags: ["auth", "api"] });
		const manifest = makeManifest([ticket]);

		await writeManifest(tmpDir, loopId, loopName, manifest);
		const result = await readManifest(tmpDir, loopId);

		const t = result!.tickets.find(t => t.id === "T2");
		expect(t).toBeDefined();
		expect(t!.tags).toEqual(["auth", "api"]);
	});

	it("gate IDs are deterministic across reads", async () => {
		const ticket = makeTicket({
			id: "G1",
			gates: [
				{
					id: "x",
					type: "command",
					command: "bun test",
					trigger: { kind: GATE_TRIGGERS.onCompletion },
				},
			],
		});
		const manifest = makeManifest([ticket]);

		await writeManifest(tmpDir, loopId, loopName, manifest);
		const result1 = await readManifest(tmpDir, loopId);
		const result2 = await readManifest(tmpDir, loopId);

		const gates1 = result1!.tickets.find(t => t.id === "G1")!.gates;
		const gates2 = result2!.tickets.find(t => t.id === "G1")!.gates;
		expect(gates1.map(g => g.id)).toEqual(gates2.map(g => g.id));
	});

	it("gate IDs are unique across tickets", async () => {
		const t1 = makeTicket({
			id: "U1",
			gates: [{ id: "a", type: "command", command: "bun test", trigger: { kind: GATE_TRIGGERS.onCompletion } }],
		});
		const t2 = makeTicket({
			id: "U2",
			gates: [{ id: "b", type: "command", command: "bun lint", trigger: { kind: GATE_TRIGGERS.onCompletion } }],
		});
		const manifest = makeManifest([t1, t2]);

		await writeManifest(tmpDir, loopId, loopName, manifest);
		const result = await readManifest(tmpDir, loopId);

		const allGateIds = result!.tickets.flatMap(t => t.gates.map(g => g.id));
		expect(new Set(allGateIds).size).toBe(allGateIds.length);
	});

	it("full round-trip with varied fields", async () => {
		const tickets = [
			makeTicket({
				id: "FULL-1",
				title: "First ticket",
				state: TICKET_STATES.doing,
				dependencies: ["FULL-2"],
				tags: ["core"],
				acceptanceCriteria: ["passes tests"],
				gates: [{ id: "g1", type: "command", command: "bun test", trigger: { kind: GATE_TRIGGERS.onCompletion } }],
				layer: "backend",
				orgItemId: "org-full-1",
				changedFiles: ["x.ts", "y.ts"],
				findings: ["perf issue"],
				iterationHistory: [1, 2],
			}),
			makeTicket({
				id: "FULL-2",
				title: "Second ticket",
				state: TICKET_STATES.done,
				triggers: ["FULL-3(keyword)"],
				tags: ["infra"],
			}),
			makeTicket({
				id: "FULL-3",
				title: "Third ticket",
				state: TICKET_STATES.blocked,
				dependencies: ["FULL-1", "FULL-2"],
			}),
		];
		const manifest = makeManifest(tickets);

		await writeManifest(tmpDir, loopId, loopName, manifest);
		const result = await readManifest(tmpDir, loopId);

		expect(result).toBeDefined();
		expect(result!.tickets).toHaveLength(3);

		const f1 = result!.tickets.find(t => t.id === "FULL-1")!;
		expect(f1.state).toBe(TICKET_STATES.doing);
		expect(f1.dependencies).toEqual(["FULL-2"]);
		expect(f1.tags).toEqual(["core"]);
		expect(f1.acceptanceCriteria).toEqual(["passes tests"]);
		expect(f1.layer).toBe("backend");
		expect(f1.orgItemId).toBe("org-full-1");
		expect(f1.changedFiles).toEqual(["x.ts", "y.ts"]);
		expect(f1.findings).toEqual(["perf issue"]);
		expect(f1.iterationHistory).toEqual([1, 2]);
		expect(f1.gates).toHaveLength(1);

		const f2 = result!.tickets.find(t => t.id === "FULL-2")!;
		expect(f2.state).toBe(TICKET_STATES.done);
		expect(f2.tags).toEqual(["infra"]);

		const f3 = result!.tickets.find(t => t.id === "FULL-3")!;
		expect(f3.state).toBe(TICKET_STATES.blocked);
		expect(f3.dependencies).toEqual(expect.arrayContaining(["FULL-1", "FULL-2"]));

		// Edge direction: from=blocker, to=dependent
		expect(result!.dependencyEdges).toContainEqual({ from: "FULL-2", to: "FULL-1" });
		expect(result!.dependencyEdges).toContainEqual({ from: "FULL-1", to: "FULL-3" });
		expect(result!.dependencyEdges).toContainEqual({ from: "FULL-2", to: "FULL-3" });

		// Trigger rules
		expect(result!.triggerRules).toContainEqual({ source: "FULL-2", target: "FULL-3", keyword: "keyword" });
	});
});
