import { describe, expect, it } from "bun:test";
import { dedupeCandidates, normalizeCanonicalUrl, normalizePublishedAt } from "../src/discovery/canonicalize";
import type { GrowthDiscoveredCandidate } from "../src/types";

function candidate(overrides: Partial<GrowthDiscoveredCandidate> = {}): GrowthDiscoveredCandidate {
	return {
		canonicalUrl: "https://example.com/post?utm_source=x",
		sourceUrl: "https://example.com/post?utm_source=x",
		title: "Example",
		sourceSlug: "ora",
		sourceLabel: "Ora",
		provenanceMode: "adjacent",
		matchedQueryId: "q1",
		matchedQuery: "growth",
		contentFingerprint: "fingerprint",
		rawResult: {},
		...overrides,
	};
}

describe("canonicalization", () => {
	it("normalizes urls, published-at values, and prefers stronger provenance", () => {
		expect(normalizeCanonicalUrl("https://example.com/post?utm_source=x#intro")).toBe("https://example.com/post");
		expect(normalizePublishedAt("2026-04-02")).toBe("2026-04-02T00:00:00.000Z");
		expect(
			dedupeCandidates([
				candidate({ provenanceMode: "adjacent" }),
				candidate({ provenanceMode: "direct", matchedQueryId: "q2" }),
			]),
		).toEqual([expect.objectContaining({ provenanceMode: "direct", matchedQueryId: "q2" })]);
	});
});
