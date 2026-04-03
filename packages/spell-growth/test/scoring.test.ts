import { describe, expect, it } from "bun:test";
import { scoreCandidate } from "../src/scoring/lexical";
import type { GrowthDiscoveredCandidate, GrowthPersonaRecord } from "../src/types";

const candidate: GrowthDiscoveredCandidate = {
	canonicalUrl: "https://example.com/post",
	sourceUrl: "https://example.com/post",
	title: "Automation for forecasting teams",
	summary: "This removes manual reporting and improves automation for finance teams.",
	sourceSlug: "ora",
	sourceLabel: "Ora",
	provenanceMode: "direct",
	matchedQueryId: "q1",
	matchedQuery: "growth",
	contentFingerprint: "fingerprint",
	rawResult: {},
};

const personas: GrowthPersonaRecord[] = [
	{
		slug: "finance",
		name: "Finance",
		summary: "",
		goals: [],
		challenges: ["manual reporting"],
		keywords: ["forecasting", "automation"],
	},
	{ slug: "ops", name: "Ops", summary: "", goals: [], challenges: ["handoffs"], keywords: ["workflow"] },
];

describe("lexical scoring", () => {
	it("computes deterministic scores, captures matches, and tie-breaks by slug", () => {
		const scores = scoreCandidate(candidate, personas);
		expect(scores[0]).toEqual(
			expect.objectContaining({
				persona: expect.objectContaining({ slug: "finance" }),
				score: 8,
				matchedKeywords: ["automation", "forecasting"],
				matchedChallenges: ["manual reporting"],
			}),
		);
		expect(scores[1].persona.slug).toBe("ops");
	});
});
