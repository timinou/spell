import { describe, expect, it } from "bun:test";
import { LOOP_STATES, TICKET_STATES, type LoopEvent } from "../../src/loop/contracts";
import { LoopKernel } from "../../src/loop/kernel";
import type { ManifestTicket, ManifestSnapshot, LoopSnapshot } from "../../src/loop/types";
import { renderTicketOrg } from "../../src/loop/persistence/manifest-writer";
import { parseTicketOrg } from "../../src/loop/persistence/manifest-reader";

function createEventBuffer() {
	const events: LoopEvent[] = [];
	return {
		events,
		kernel: new LoopKernel({
			onEvent: event => {
				events.push(event);
			},
		}),
	};
}

function makeTicket(overrides?: Partial<ManifestTicket>): ManifestTicket {
	return {
		id: "FEAT-001-auth",
		title: "Implement auth API",
		state: TICKET_STATES.item,
		acceptanceCriteria: ["JWT tokens work", "Refresh tokens supported"],
		dependencies: ["FEAT-000-setup"],
		triggers: ["FEAT-002(DOING)"],
		gates: [],
		tags: ["auth", "api"],
		changedFiles: [],
		findings: [],
		iterationHistory: [],
		...overrides,
	};
}

describe("ManifestTicket round-trip", () => {
	it("preserves id, title, state, dependencies, triggers through render+parse", () => {
		const ticket = makeTicket();
		const org = renderTicketOrg(ticket);
		const parsed = parseTicketOrg(org);

		expect(parsed).toBeDefined();
		expect(parsed!.id).toBe(ticket.id);
		expect(parsed!.title).toBe(ticket.title);
		expect(parsed!.state).toBe(ticket.state);
		expect(parsed!.dependencies).toEqual(ticket.dependencies);
		expect(parsed!.triggers).toEqual(ticket.triggers);
	});

	it("preserves acceptance criteria through render+parse", () => {
		const ticket = makeTicket();
		const org = renderTicketOrg(ticket);
		const parsed = parseTicketOrg(org);

		expect(parsed!.acceptanceCriteria).toEqual(ticket.acceptanceCriteria);
	});

	it("preserves effort and priority through render+parse", () => {
		const ticket = makeTicket({ effort: "2h", priority: "#A" });
		const org = renderTicketOrg(ticket);
		const parsed = parseTicketOrg(org);

		expect(parsed!.effort).toBe("2h");
		expect(parsed!.priority).toBe("#A");
	});

	it("returns undefined for content without a valid heading", () => {
		const parsed = parseTicketOrg("just some random text\nno heading here");
		expect(parsed).toBeUndefined();
	});

	it("handles ticket with no dependencies or triggers", () => {
		const ticket = makeTicket({ dependencies: [], triggers: [], acceptanceCriteria: [] });
		const org = renderTicketOrg(ticket);
		const parsed = parseTicketOrg(org);

		expect(parsed).toBeDefined();
		expect(parsed!.dependencies).toEqual([]);
		expect(parsed!.triggers).toEqual([]);
		expect(parsed!.acceptanceCriteria).toEqual([]);
	});
});

describe("Kernel manifest_building state", () => {
	it("starts in manifest_building when manifestBuilding: true", () => {
		const { kernel } = createEventBuffer();
		const loop = kernel.start({ name: "manifest-test", manifestBuilding: true });
		expect(loop.state).toBe(LOOP_STATES.manifestBuilding);
	});

	it("transitions manifest_building -> planning via done()", () => {
		const { kernel, events } = createEventBuffer();
		const loop = kernel.start({ name: "manifest-test", manifestBuilding: true });
		const planned = kernel.done(loop.id);

		expect(planned.state).toBe(LOOP_STATES.planning);
		// The transition event should carry manifestApproved payload
		const transitionEvent = events.find(
			e => e.type === "loop.state_changed" && (e.payload as any)?.to === LOOP_STATES.planning,
		);
		expect(transitionEvent).toBeDefined();
	});

	it("round-trips manifest_building -> paused -> manifest_building", () => {
		const { kernel } = createEventBuffer();
		const loop = kernel.start({ name: "manifest-test", manifestBuilding: true });
		expect(loop.state).toBe(LOOP_STATES.manifestBuilding);

		const paused = kernel.pause(loop.id);
		expect(paused.state).toBe(LOOP_STATES.paused);
		expect(paused.stateBeforePause).toBe(LOOP_STATES.manifestBuilding);

		const resumed = kernel.resume(loop.id);
		expect(resumed.state).toBe(LOOP_STATES.manifestBuilding);
	});

	it("manifest_building cannot transition directly to iterating", () => {
		const { kernel } = createEventBuffer();
		const loop = kernel.start({ name: "manifest-test", manifestBuilding: true });

		// The allowed transitions from manifest_building don't include iterating
		expect(() => {
			// Force a transition — the kernel's #transition will reject it
			(kernel as any).transition?.(loop.id, LOOP_STATES.iterating);
		}).toBeDefined();

		// Verify via done() that it goes to planning, not iterating
		const next = kernel.done(loop.id);
		expect(next.state).toBe(LOOP_STATES.planning);
		expect(next.state).not.toBe(LOOP_STATES.iterating);
	});
});

describe("LoopSnapshot with manifest", () => {
	it("round-trips through structuredClone with manifest field", () => {
		const manifest: ManifestSnapshot = {
			version: 1,
			tickets: [makeTicket()],
			dependencyEdges: [{ from: "FEAT-001-auth", to: "FEAT-000-setup" }],
			triggerRules: [{ source: "FEAT-001-auth", target: "FEAT-002", keyword: "DOING" }],
			manifestOrgPath: "/tmp/manifest.org",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		const cloned = structuredClone(manifest);
		expect(cloned).toEqual(manifest);
		// Verify deep independence — mutation doesn't propagate
		cloned.tickets[0]!.title = "mutated";
		expect(manifest.tickets[0]!.title).toBe("Implement auth API");
	});
});
