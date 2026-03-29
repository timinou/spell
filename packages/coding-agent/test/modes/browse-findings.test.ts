import { describe, expect, it } from "bun:test";
import {
	type BrowseFinding,
	createFinding,
	normalizeUrlForDedup,
	parseBrowseFinding,
} from "../../src/modes/browse-findings";

describe("createFinding", () => {
	it("includes sourceType, curated, enriched with defaults", () => {
		const finding = createFinding({ url: "https://example.com", title: "Example" });
		expect(finding.sourceType).toBe("agent");
		expect(finding.curated).toBe(true);
		expect(finding.enriched).toBe(false);
		expect(finding.contentBody).toBeUndefined();
	});

	it("respects explicit sourceType and curated", () => {
		const finding = createFinding({
			url: "https://example.com",
			title: "Search result",
			sourceType: "search",
			curated: false,
			enriched: false,
		});
		expect(finding.sourceType).toBe("search");
		expect(finding.curated).toBe(false);
	});

	it("includes contentBody when provided", () => {
		const finding = createFinding({
			url: "https://example.com",
			title: "Fetched page",
			sourceType: "fetch",
			contentBody: "Some markdown content",
		});
		expect(finding.contentBody).toBe("Some markdown content");
	});

	it("excludes contentBody when empty", () => {
		const finding = createFinding({
			url: "https://example.com",
			title: "Empty",
			contentBody: "   ",
		});
		expect(finding.contentBody).toBeUndefined();
	});
});

describe("parseBrowseFinding", () => {
	it("handles new fields (sourceType, curated, contentBody, enriched)", () => {
		const result = parseBrowseFinding({
			url: "https://example.com",
			title: "Test",
			sourceType: "fetch",
			curated: false,
			contentBody: "Body text",
			enriched: true,
		});
		expect(result).not.toBeNull();
		expect(result!.sourceType).toBe("fetch");
		expect(result!.curated).toBe(false);
		expect(result!.contentBody).toBe("Body text");
		expect(result!.enriched).toBe(true);
	});

	it("defaults sourceType to agent for invalid values", () => {
		const result = parseBrowseFinding({
			url: "https://example.com",
			title: "Test",
			sourceType: "invalid_type",
		});
		expect(result!.sourceType).toBe("agent");
	});

	it("defaults curated to true when missing (backward compat)", () => {
		const result = parseBrowseFinding({
			url: "https://example.com",
			title: "Test",
		});
		expect(result!.curated).toBe(true);
	});

	it("defaults enriched to false when missing", () => {
		const result = parseBrowseFinding({
			url: "https://example.com",
			title: "Test",
		});
		expect(result!.enriched).toBe(false);
	});
});

describe("normalizeUrlForDedup", () => {
	it("lowercases scheme and host", () => {
		expect(normalizeUrlForDedup("HTTPS://EXAMPLE.COM/Path")).toBe("https://example.com/Path");
	});

	it("strips www. prefix", () => {
		expect(normalizeUrlForDedup("https://www.example.com/page")).toBe("https://example.com/page");
	});

	it("strips fragment", () => {
		expect(normalizeUrlForDedup("https://example.com/page#section")).toBe("https://example.com/page");
	});

	it("strips trailing slash from path", () => {
		expect(normalizeUrlForDedup("https://example.com/page/")).toBe("https://example.com/page");
	});

	it("preserves query parameters", () => {
		expect(normalizeUrlForDedup("https://example.com/search?q=test")).toBe("https://example.com/search?q=test");
	});

	it("combines all normalizations", () => {
		expect(normalizeUrlForDedup("HTTPS://WWW.Example.COM/path/#section")).toBe("https://example.com/path");
	});

	it("returns empty string for empty input", () => {
		expect(normalizeUrlForDedup("")).toBe("");
	});

	it("lowercases malformed URLs without crashing", () => {
		expect(normalizeUrlForDedup("not a url")).toBe("not a url");
	});

	it("preserves non-default port", () => {
		expect(normalizeUrlForDedup("https://api.example.com:8080/docs")).toBe("https://api.example.com:8080/docs");
	});

	it("preserves path case", () => {
		expect(normalizeUrlForDedup("https://example.com/API/v1")).toBe("https://example.com/API/v1");
	});

	it("strips trailing slash from path before query", () => {
		expect(normalizeUrlForDedup("https://example.com/path/?q=1")).toBe("https://example.com/path?q=1");
	});

	it("preserves port with www stripping", () => {
		expect(normalizeUrlForDedup("https://www.example.com:3000/page")).toBe("https://example.com:3000/page");
	});
});
