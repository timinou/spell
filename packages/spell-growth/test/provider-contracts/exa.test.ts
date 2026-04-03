import { describe, expect, it } from "bun:test";
import { HttpExaClient, normalizeExaResults } from "../../src/discovery/providers/exa";

describe("exa provider contract", () => {
	it("normalizes results, preserves empty results, and surfaces provider failures", async () => {
		expect(normalizeExaResults({ results: [] })).toEqual([]);
		const client = new HttpExaClient({
			apiKey: "test-key", // pragma: allowlist secret
			apiBaseUrl: "https://exa.test",
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						results: [{ url: "https://example.com", title: "  Example  ", summary: " Summary " }],
					}),
					{ status: 200 },
				),
		});
		expect(await client.search({ query: "growth" })).toEqual([
			{ url: "https://example.com", title: "Example", summary: "Summary" },
		]);

		const failingClient = new HttpExaClient({
			apiKey: "test-key", // pragma: allowlist secret
			apiBaseUrl: "https://exa.test",
			fetchImpl: async () => new Response("boom", { status: 502 }),
		});
		await expect(failingClient.search({ query: "growth" })).rejects.toThrow(/Exa search failed/);
	});
});
