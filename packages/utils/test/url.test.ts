import { describe, expect, it } from "bun:test";
import { normalizeCanonicalUrl, normalizePublishedAt } from "../src/url";

describe("normalizeCanonicalUrl", () => {
	it("strips tracking params while preserving non-tracking params", () => {
		expect(
			normalizeCanonicalUrl(
				"https://example.com/post?utm_source=newsletter&page=2&ref=feed&utm_medium=email&tag=typescript&source=rss#intro",
			),
		).toBe("https://example.com/post?page=2&tag=typescript");
	});

	it("removes hash fragments when no search params are present", () => {
		expect(normalizeCanonicalUrl("https://example.com/post#section-1")).toBe("https://example.com/post");
	});

	it("removes an empty search after stripping tracking params", () => {
		expect(normalizeCanonicalUrl("https://example.com/post?utm_campaign=spring&source=rss#top")).toBe(
			"https://example.com/post",
		);
	});

	it("returns undefined for invalid urls", () => {
		expect(normalizeCanonicalUrl("not a url")).toBeUndefined();
	});

	it("leaves urls without tracking params unchanged apart from URL normalization", () => {
		expect(normalizeCanonicalUrl("https://example.com/post?topic=spell&sort=new")).toBe(
			"https://example.com/post?topic=spell&sort=new",
		);
	});
});

describe("normalizePublishedAt", () => {
	it("converts date-only strings to midnight UTC ISO timestamps", () => {
		expect(normalizePublishedAt("2026-04-02")).toBe("2026-04-02T00:00:00.000Z");
	});

	it("parses full date strings after trimming whitespace", () => {
		expect(normalizePublishedAt(" 2026-04-02T15:30:45-05:00 ")).toBe("2026-04-02T20:30:45.000Z");
	});

	it("returns undefined for empty or invalid input", () => {
		expect(normalizePublishedAt()).toBeUndefined();
		expect(normalizePublishedAt("   ")).toBeUndefined();
		expect(normalizePublishedAt("not a date")).toBeUndefined();
	});
});
