import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GATE_TRIGGERS, TICKET_STATES } from "../../src/loop/contracts";
import { LoopManager } from "../../src/loop/loop-manager";
import { readManifest } from "../../src/loop/persistence/manifest-reader";
import { writeManifest } from "../../src/loop/persistence/manifest-writer";
import type { ManifestSnapshot, ManifestTicket } from "../../src/loop/types";

function createSettings() {
	return {
		getModelRole(role: string) {
			return role === "review" ? "anthropic/claude-sonnet-4-6" : undefined;
		},
	};
}

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

describe("manifest lifecycle persistence", () => {
	let cwd: string;
	let manager: LoopManager;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-lifecycle-"));
		manager = new LoopManager({ cwd, settings: createSettings() });
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("launch() reads manifest from disk and populates snapshot", async () => {
		const loop = await manager.start({ name: "test", manifestBuilding: true, domains: [] });

		// Manually write manifest files to the expected location
		const manifest = makeManifest([
			makeTicket({ id: "T-001", state: TICKET_STATES.item }),
			makeTicket({ id: "T-002", state: TICKET_STATES.item, dependencies: ["T-001"] }),
		]);
		await writeManifest(cwd, loop.id, "test", manifest);

		// Launch should read manifest from disk
		const launched = await manager.launch(loop.id);
		const snapshot = manager.getLoop(loop.id);

		expect(snapshot.manifest).toBeDefined();
		expect(snapshot.manifest!.tickets).toHaveLength(2);
		const ids = snapshot.manifest!.tickets.map(t => t.id).sort();
		expect(ids).toEqual(["T-001", "T-002"]);
	});

	it("launch() with no manifest files proceeds without manifest", async () => {
		const loop = await manager.start({ name: "test", manifestBuilding: true, domains: [] });

		// Don't write any manifest files
		const launched = await manager.launch(loop.id);
		const snapshot = manager.getLoop(loop.id);

		// Should proceed fine — manifest stays undefined for legacy loops
		expect(snapshot.manifest).toBeUndefined();
		expect(snapshot.state).toBe("planning");
	});

	it("launch() registers ticket gates from manifest", async () => {
		const loop = await manager.start({ name: "test", manifestBuilding: true, domains: [] });

		const manifest = makeManifest([
			makeTicket({
				id: "T-001",
				gates: [
					{
						id: "gate-cmd-T-001",
						type: "command",
						command: "bun test",
						trigger: { kind: GATE_TRIGGERS.onCompletion },
					},
				],
			}),
		]);
		await writeManifest(cwd, loop.id, "test", manifest);

		await manager.launch(loop.id);

		// The evaluator should have gates registered — we verify via the snapshot having manifest
		const snapshot = manager.getLoop(loop.id);
		expect(snapshot.manifest).toBeDefined();
		expect(snapshot.manifest!.tickets[0].gates).toHaveLength(1);
	});

	it("markDone() writes manifest to disk after ticket transitions", async () => {
		const loop = await manager.start({ name: "test", manifestBuilding: true, domains: [] });

		// Write manifest with DOING ticket
		const manifest = makeManifest([makeTicket({ id: "T-001", state: TICKET_STATES.doing })]);
		await writeManifest(cwd, loop.id, "test", manifest);

		await manager.launch(loop.id); // -> planning (manifest loaded)
		await manager.markDone(loop.id); // -> iterating

		// Complete the ticket
		await manager.markDone(loop.id, {
			summary: "done",
			completedTickets: ["T-001"],
		});

		// Read manifest from disk — should reflect DONE state
		const onDisk = await readManifest(cwd, loop.id);
		expect(onDisk).toBeDefined();
		const ticket = onDisk!.tickets.find(t => t.id === "T-001");
		expect(ticket?.state).toBe(TICKET_STATES.done);
	});

	it("launch() with empty manifest (0 tickets) proceeds without setting manifest", async () => {
		const loop = await manager.start({ name: "test", manifestBuilding: true, domains: [] });

		// Write manifest with 0 tickets
		const manifest = makeManifest([]);
		await writeManifest(cwd, loop.id, "test", manifest);

		await manager.launch(loop.id);
		const snapshot = manager.getLoop(loop.id);

		// Empty manifest is not loaded (tickets.length === 0 guard)
		expect(snapshot.manifest).toBeUndefined();
	});
});
