import { describe, expect, it } from "bun:test";
import { TICKET_STATES } from "../../src/loop/contracts";
import { type DriftReport, mergeManifestWithDrift } from "../../src/loop/git/manifest-drift";
import type { ParsedSpecFile } from "../../src/loop/ingestion/parser";
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

function emptyDrift(overrides?: Partial<DriftReport>): DriftReport {
	return {
		modified: [],
		added: [],
		deleted: [],
		affectedTickets: [],
		newItems: [],
		removedItems: [],
		...overrides,
	};
}

describe("mergeManifestWithDrift", () => {
	it("removes ticket when CUSTOM_ID is renamed in a modified file", () => {
		const manifest = makeManifest([makeTicket({ id: "A", specPath: "spec.org" })]);
		const drift = emptyDrift({ modified: ["spec.org"] });
		const newSpecs: ParsedSpecFile[] = [{ path: "spec.org", customIds: ["B"], content: "", links: [] }];

		const result = mergeManifestWithDrift(manifest, drift, newSpecs);

		expect(result.removed).toContain("A");
		expect(result.added.map(t => t.id)).toContain("B");
		expect(result.manifest.tickets.map(t => t.id)).not.toContain("A");
		expect(result.manifest.tickets.map(t => t.id)).toContain("B");
	});

	it("preserves DONE ticket when CUSTOM_ID is renamed in a modified file", () => {
		const manifest = makeManifest([makeTicket({ id: "A", specPath: "spec.org", state: TICKET_STATES.done })]);
		const drift = emptyDrift({ modified: ["spec.org"] });
		const newSpecs: ParsedSpecFile[] = [{ path: "spec.org", customIds: ["B"], content: "", links: [] }];

		const result = mergeManifestWithDrift(manifest, drift, newSpecs);

		expect(result.preserved).toContain("A");
		expect(result.removed).not.toContain("A");
		expect(result.added.map(t => t.id)).toContain("B");
	});

	it("keeps ticket when ID still exists in modified file", () => {
		const manifest = makeManifest([makeTicket({ id: "A", specPath: "spec.org" })]);
		const drift = emptyDrift({ modified: ["spec.org"] });
		const newSpecs: ParsedSpecFile[] = [{ path: "spec.org", customIds: ["A"], content: "", links: [] }];

		const result = mergeManifestWithDrift(manifest, drift, newSpecs);

		expect(result.removed).toEqual([]);
		expect(result.manifest.tickets.map(t => t.id)).toContain("A");
	});

	it("handles multiple renames in a modified file", () => {
		const manifest = makeManifest([
			makeTicket({ id: "A", specPath: "spec.org" }),
			makeTicket({ id: "B", specPath: "spec.org" }),
		]);
		const drift = emptyDrift({ modified: ["spec.org"] });
		const newSpecs: ParsedSpecFile[] = [{ path: "spec.org", customIds: ["C", "D"], content: "", links: [] }];

		const result = mergeManifestWithDrift(manifest, drift, newSpecs);

		expect(result.removed).toContain("A");
		expect(result.removed).toContain("B");
		expect(result.added.map(t => t.id)).toContain("C");
		expect(result.added.map(t => t.id)).toContain("D");
	});

	it("removes ticket when its spec file is deleted", () => {
		const manifest = makeManifest([makeTicket({ id: "A", specPath: "spec.org" })]);
		const drift = emptyDrift({ deleted: ["spec.org"] });
		const newSpecs: ParsedSpecFile[] = [];

		const result = mergeManifestWithDrift(manifest, drift, newSpecs);

		expect(result.removed).toContain("A");
		expect(result.manifest.tickets.map(t => t.id)).not.toContain("A");
	});
});
