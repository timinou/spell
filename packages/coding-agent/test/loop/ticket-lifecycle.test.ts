import { beforeEach, describe, expect, it } from "bun:test";
import { TICKET_STATES } from "../../src/loop/contracts";
import { TicketLifecycleManager } from "../../src/loop/ticket-lifecycle";
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
		manifestOrgPath: "/tmp/manifest.org",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

describe("TicketLifecycleManager", () => {
	let mgr: TicketLifecycleManager;

	beforeEach(() => {
		mgr = new TicketLifecycleManager();
	});

	it("ITEM -> DOING transition succeeds", () => {
		const manifest = makeManifest([makeTicket({ id: "T-1" })]);
		const result = mgr.startTicket(manifest, "T-1", 1);
		expect(result.ticket.state).toBe(TICKET_STATES.doing);
		expect(result.previousState).toBe(TICKET_STATES.item);
	});

	it("DOING -> DONE transition succeeds", () => {
		const manifest = makeManifest([makeTicket({ id: "T-1", state: TICKET_STATES.doing })]);
		const result = mgr.completeTicket(manifest, "T-1", 1);
		expect(result.ticket.state).toBe(TICKET_STATES.done);
	});

	it("DONE is terminal — rejects further transitions", () => {
		const manifest = makeManifest([makeTicket({ id: "T-1", state: TICKET_STATES.done })]);
		expect(() => mgr.transitionTicket(manifest, "T-1", TICKET_STATES.doing)).toThrow(/Invalid transition/);
	});

	it("starting ticket with unmet dependencies throws", () => {
		const manifest = makeManifest([
			makeTicket({ id: "T-1", dependencies: ["T-2"] }),
			makeTicket({ id: "T-2" }), // still ITEM, not DONE
		]);
		expect(() => mgr.startTicket(manifest, "T-1", 1)).toThrow(/unmet dependencies/);
	});

	it("completing ticket A unblocks ticket B that had A as sole blocker", () => {
		const manifest = makeManifest([
			makeTicket({ id: "A", state: TICKET_STATES.doing }),
			makeTicket({ id: "B", state: TICKET_STATES.blocked, dependencies: ["A"] }),
		]);
		const result = mgr.completeTicket(manifest, "A", 1);
		expect(result.unblockedTickets).toContain("B");
		const ticketB = manifest.tickets.find(t => t.id === "B")!;
		expect(ticketB.state).toBe(TICKET_STATES.item);
	});

	it("getReadyTickets returns only tickets with satisfied deps", () => {
		const manifest = makeManifest([
			makeTicket({ id: "A" }), // ITEM, no deps — ready
			makeTicket({ id: "B", dependencies: ["C"] }), // dep unmet
			makeTicket({ id: "C", state: TICKET_STATES.doing }), // not DONE
		]);
		const ready = mgr.getReadyTickets(manifest);
		expect(ready.map(t => t.id)).toEqual(["A"]);
	});

	it("getProgressSummary returns correct format", () => {
		const manifest = makeManifest([
			makeTicket({ id: "A", state: TICKET_STATES.done }),
			makeTicket({ id: "B", state: TICKET_STATES.doing }),
			makeTicket({ id: "C" }),
		]);
		const summary = mgr.getProgressSummary(manifest);
		expect(summary).toContain("1/3");
		expect(typeof summary).toBe("string");
	});

	it("isManifestComplete returns true when all tickets are DONE", () => {
		const allDone = makeManifest([
			makeTicket({ id: "A", state: TICKET_STATES.done }),
			makeTicket({ id: "B", state: TICKET_STATES.done }),
		]);
		expect(mgr.isManifestComplete(allDone)).toBe(true);

		const notDone = makeManifest([
			makeTicket({ id: "A", state: TICKET_STATES.done }),
			makeTicket({ id: "B", state: TICKET_STATES.doing }),
		]);
		expect(mgr.isManifestComplete(notDone)).toBe(false);
	});
});
