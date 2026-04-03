import { describe, expect, it } from "bun:test";
import { buildDiscoveryPlan } from "../src/discovery/planner";
import type { GrowthPersonaRecord, GrowthSourceRecord } from "../src/types";

const personas: GrowthPersonaRecord[] = [
	{
		slug: "ops",
		name: "Ops",
		summary: "Ops buyers",
		goals: ["Reduce toil"],
		challenges: ["Manual reporting"],
		keywords: ["automation", "ops"],
	},
];

describe("discovery planner", () => {
	it("builds deterministic direct, fallback, and adjacent queries with stable ids", () => {
		const directSources: GrowthSourceRecord[] = [
			{ slug: "ora", label: "Ora", kind: "website", value: "https://ora.example", direct: true, priority: 1 },
		];
		const directPlan = buildDiscoveryPlan(directSources, personas);
		expect(directPlan.directQueries[0]).toEqual(
			expect.objectContaining({ id: "ora:direct:0", kind: "direct", query: "site:ora.example article" }),
		);
		expect(directPlan.fallbackQueries).toEqual([]);
		expect(directPlan.adjacentQueries[0].id).toBe("adjacent-1:adjacent:0");

		const fallbackSources: GrowthSourceRecord[] = [
			{ slug: "search", label: "Search", kind: "search", value: "ora ventures growth", direct: false, priority: 1 },
		];
		const fallbackPlan = buildDiscoveryPlan(fallbackSources, personas);
		expect(fallbackPlan.directQueries).toEqual([]);
		expect(fallbackPlan.fallbackQueries[0]).toEqual(
			expect.objectContaining({ id: "search:fallback:0", query: "ora ventures growth" }),
		);
	});
});
