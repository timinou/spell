import { describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../spell-server/src/workflow";
import { InMemoryReviewStore, ingestDiscoveryCandidates } from "../src/actions/discovery";
import type { GrowthDiscoveredCandidate, GrowthPersonaRecord, GrowthSourceRecord } from "../src/types";

const personas: GrowthPersonaRecord[] = [
	{
		slug: "ops",
		name: "Ops",
		summary: "Ops buyers",
		goals: [],
		challenges: ["manual reporting"],
		keywords: ["automation"],
	},
];
const sources: GrowthSourceRecord[] = [
	{ slug: "ora", label: "Ora", kind: "website", value: "https://ora.example", direct: true, priority: 1 },
];
const candidate: GrowthDiscoveredCandidate = {
	canonicalUrl: "https://example.com/post",
	sourceUrl: "https://example.com/post",
	title: "Automation post",
	summary: "Automation removes manual reporting.",
	sourceSlug: "ora",
	sourceLabel: "Ora",
	provenanceMode: "direct",
	matchedQueryId: "q1",
	matchedQuery: "growth",
	contentFingerprint: "fingerprint",
	rawResult: {},
};

describe("review item creation", () => {
	it("upserts canonical candidates and links them to workflow review items", () => {
		const engine = new WorkflowEngine();
		const store = new InMemoryReviewStore();
		const first = ingestDiscoveryCandidates({ engine, store, sources, personas, candidates: [candidate] });
		const second = ingestDiscoveryCandidates({ engine, store, sources, personas, candidates: [candidate] });

		expect(first[0].reviewItemId).toBe(second[0].reviewItemId);
		expect(store.list()).toHaveLength(1);
		expect(engine.listItems()).toHaveLength(1);
	});
});
