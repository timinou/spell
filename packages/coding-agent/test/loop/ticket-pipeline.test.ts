import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GATE_TRIGGERS, TICKET_STATES } from "../../src/loop/contracts";
import { LoopManager } from "../../src/loop/loop-manager";
import { writeManifest } from "../../src/loop/persistence/manifest-writer";
import type { LoopGateConfig, ManifestSnapshot, ManifestTicket } from "../../src/loop/types";

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

describe("ticket completion pipeline in LoopManager.markDone", () => {
	let cwd: string;
	let manager: LoopManager;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ticket-pipeline-"));
		manager = new LoopManager({ cwd, settings: createSettings() });
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	async function setupLoopWithManifest(manifest: ManifestSnapshot) {
		const loop = await manager.start({ name: "test", manifestBuilding: true, domains: [] });
		// Set manifest on snapshot via kernel (accessed through manager's internal)
		// We use launch to move from manifest_building -> planning, but first set the manifest
		// The manager exposes getLoop, and we can use the internal kernel via reflection,
		// but a cleaner approach: prepare the loop, then manually set manifest
		// Actually, the manager doesn't expose a direct "set manifest" method.
		// Per the plan design, launch() will read manifest from disk (FEAT-073).
		// For this test, we need to set it directly. Use the LoopKernel approach.
		// Since we can't access #kernel directly, we'll use a workaround:
		// Create a test-specific subclass or use the kernel-commands pattern.

		// Actually, looking at the test pattern in kernel-commands.test.ts, it uses LoopManager directly.
		// The trick: we can call launch to get to planning, then use markDone to get to iterating.
		// At that point we need manifest on the snapshot. Since FEAT-073 hasn't wired launch() yet,
		// we need another approach.

		// The cleanest approach: import LoopKernel directly and create the manager with a known kernel.
		// But LoopManager creates its own kernel internally.

		// Alternative: We can test the ticket pipeline by using a lower-level approach.
		// Let's just test at the kernel level and verify the TLM wiring separately.

		// Actually, re-reading loop-manager.ts: the kernel is private (#kernel).
		// But we can test the observable behavior: if we set up a manifest and call markDone
		// with completedTickets, the getLoop() should show updated ticket states.

		// The issue is: how do we get a manifest onto the snapshot without FEAT-073?
		// We can use the fact that LoopKernel.updateLoop is called in various places.
		// The manager won't let us set manifest directly, but we can file-system prepare
		// a manifest and have launch() read it — except that wiring is FEAT-073.

		// For unit testing FEAT-074 alone, let's use a different approach:
		// test the TicketLifecycleManager integration via the LoopKernel directly.

		return loop;
	}

	// Since FEAT-074 wires TLM into LoopManager.markDone(), but the manifest
	// must be on the snapshot for it to work, and FEAT-073 handles putting it there,
	// we test the pipeline via LoopKernel + the new code path.
	// These tests verify the contract: when markDone is called with completedTickets
	// and the snapshot has a manifest, ticket states change.

	it("markDone with completedTickets transitions tickets from DOING to DONE", async () => {
		const loop = await manager.start({ name: "test", manifestBuilding: true, domains: [] });

		// Write manifest with a DOING ticket to disk
		const manifest = makeManifest([makeTicket({ id: "T-001", state: TICKET_STATES.doing })]);
		await writeManifest(cwd, loop.id, "test", manifest);

		await manager.launch(loop.id); // -> planning (manifest loaded from disk)
		await manager.markDone(loop.id); // -> iterating

		const result = await manager.markDone(loop.id, {
			summary: "iteration work",
			completedTickets: ["T-001"],
		});
		// Ticket should have been transitioned to DONE
		const snapshot = manager.getLoop(loop.id);
		const ticket = snapshot.manifest?.tickets.find(t => t.id === "T-001");
		expect(ticket?.state).toBe(TICKET_STATES.done);
	});

	it("markDone without completedTickets (legacy path) still works", async () => {
		const loop = await manager.start({ name: "test", manifestBuilding: true, domains: [] });
		await manager.launch(loop.id);
		await manager.markDone(loop.id); // -> iterating

		const result = await manager.markDone(loop.id, {
			summary: "no tickets",
		});
		expect(result).toBeDefined();
	});

	it("markDone with completedTickets on loop without manifest silently ignores tickets", async () => {
		const loop = await manager.start({ name: "test", manifestBuilding: true, domains: [] });
		await manager.launch(loop.id);
		await manager.markDone(loop.id); // -> iterating

		// This should not throw — no manifest means ticket processing is skipped
		const result = await manager.markDone(loop.id, {
			summary: "work done",
			completedTickets: ["nonexistent-ticket"],
			activeTickets: ["another-ticket"],
		});
		expect(result).toBeDefined();
	});
});

// Test ticket transitions with direct kernel + TLM integration
describe("ticket pipeline direct integration", () => {
	it("completeTicket transitions DOING to DONE and cascades unblocks", async () => {
		const { TicketLifecycleManager } = await import("../../src/loop/ticket-lifecycle");
		const tlm = new TicketLifecycleManager();

		const manifest = makeManifest([
			makeTicket({ id: "A", state: TICKET_STATES.doing }),
			makeTicket({ id: "B", state: TICKET_STATES.blocked, dependencies: ["A"] }),
		]);

		const result = tlm.completeTicket(manifest, "A", 1);
		expect(result.ticket.state).toBe(TICKET_STATES.done);
		expect(result.unblockedTickets).toContain("B");

		const ticketB = manifest.tickets.find(t => t.id === "B");
		expect(ticketB?.state).toBe(TICKET_STATES.item);
	});

	it("startTicket transitions ITEM to DOING", async () => {
		const { TicketLifecycleManager } = await import("../../src/loop/ticket-lifecycle");
		const tlm = new TicketLifecycleManager();

		const manifest = makeManifest([makeTicket({ id: "A", state: TICKET_STATES.item })]);

		const result = tlm.startTicket(manifest, "A", 1);
		expect(result.ticket.state).toBe(TICKET_STATES.doing);
		expect(result.ticket.iterationHistory).toContain(1);
	});

	it("ticket gates fire for onTicketComplete trigger", async () => {
		const { shouldFire } = await import("../../src/loop/gates/trigger");

		const gate: LoopGateConfig = {
			id: "ticket-A-cmd-0",
			type: "command",
			command: "bun test",
			trigger: { kind: GATE_TRIGGERS.onTicketComplete },
		};

		expect(shouldFire(gate, { iteration: 1, state: "iterating", ticketCompleted: "A" })).toBe(true);
		expect(shouldFire(gate, { iteration: 1, state: "iterating" })).toBe(false);
	});
});
