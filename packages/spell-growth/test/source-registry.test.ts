import { describe, expect, it } from "bun:test";
import { loadSourceRegistry } from "../src/registries/source-loader";

describe("source registry", () => {
	it("parses sources, preserves priority ordering, and rejects duplicate collisions", () => {
		const records =
			loadSourceRegistry(`source "newsletter" label="Newsletter" kind="newsletter" value="https://example.com/news" priority=2
source "website" label="Website" kind="website" value="https://example.com" priority=1
`);
		expect(records.map(record => record.slug)).toEqual(["website", "newsletter"]);
		expect(() =>
			loadSourceRegistry(`source "website" label="One" kind="website" value="https://example.com"
source "website" label="Two" kind="website" value="https://example.com/"
`),
		).toThrow(/Duplicate source slug/);
		expect(() =>
			loadSourceRegistry(`source "one" label="One" kind="website" value="https://example.com"
source "two" label="Two" kind="website" value="https://www.example.com"
`),
		).toThrow(/Duplicate source value/);
	});
});
