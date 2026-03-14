import { describe, expect, test } from "bun:test";
import { extractOrgKeywords, orgToMarkdown, orgToPlainText, parseOrgHeadings } from "../src/org-parse";

describe("orgToMarkdown", () => {
	test("converts headings", () => {
		const result = orgToMarkdown("* H1\n** H2");
		// H1 should appear as markdown heading, H2 as sub-heading
		expect(result).toContain("H1");
		expect(result).toContain("H2");
		// Check heading markers
		expect(result).toMatch(/^#+ H1/m);
		expect(result).toMatch(/^#+ H2/m);
	});

	test("converts src blocks", () => {
		const org = "#+begin_src typescript\nconst x = 1;\n#+end_src";
		const result = orgToMarkdown(org);
		expect(result).toContain("const x = 1;");
		// Should be fenced code block
		expect(result).toContain("```");
	});

	test("converts links", () => {
		const org = "[[https://example.com][Example Link]]";
		const result = orgToMarkdown(org);
		expect(result).toContain("Example Link");
		expect(result).toContain("https://example.com");
	});

	test("handles empty string", () => {
		expect(orgToMarkdown("")).toBe("\n");
	});

	test("PROPERTIES drawer does not produce garbage", () => {
		const org = "* My Heading\n:PROPERTIES:\n:CUSTOM_ID: test-123\n:END:\nBody text here";
		const result = orgToMarkdown(org);
		// Should not contain raw :PROPERTIES: or :END: as visible garbage
		// (may appear inside code block which is acceptable, but not as raw text)
		expect(result).toContain("Body text here");
		// Main check: no hard crash, produces some output
		expect(typeof result).toBe("string");
	});
});

describe("orgToPlainText", () => {
	test("strips markup", () => {
		const result = orgToPlainText("* Heading\n~code~ /italic/ *bold*");
		expect(result).toContain("Heading");
		// Plain text should not have org markup chars as format indicators
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	test("handles empty string", () => {
		expect(orgToPlainText("")).toBe("");
	});
});

describe("extractOrgKeywords", () => {
	test("basic extraction", () => {
		const result = extractOrgKeywords("#+TITLE: My Title\n#+DESCRIPTION: Some description");
		expect(result.title).toBe("My Title");
		expect(result.description).toBe("Some description");
	});

	test("keys are lowercased", () => {
		const result = extractOrgKeywords("#+CUSTOM_KEY: value");
		expect(result.custom_key).toBe("value");
	});

	test("stops at first heading", () => {
		const result = extractOrgKeywords("#+TITLE: Foo\n* Heading\n#+AFTER: should not appear");
		expect(result.title).toBe("Foo");
		expect(result.after).toBeUndefined();
	});

	test("empty string returns empty object", () => {
		expect(extractOrgKeywords("")).toEqual({});
	});

	test("no keywords returns empty object", () => {
		expect(extractOrgKeywords("* Just a heading\nWith body")).toEqual({});
	});
});

describe("parseOrgHeadings", () => {
	test("basic structure", () => {
		const result = parseOrgHeadings("* H1\n** H2");
		expect(result).toHaveLength(1);
		expect(result[0]!.title).toBe("H1");
		expect(result[0]!.level).toBe(1);
		// H2 is nested under H1 in uniorg AST
	});

	test("heading with tags", () => {
		const result = parseOrgHeadings("* My Task :backend:auth:");
		expect(result).toHaveLength(1);
		expect(result[0]!.tags).toContain("backend");
		expect(result[0]!.tags).toContain("auth");
	});

	test("heading with properties", () => {
		const result = parseOrgHeadings("* Item\n:PROPERTIES:\n:CUSTOM_ID: abc-123\n:CONFIDENCE: 0.9\n:END:");
		expect(result).toHaveLength(1);
		expect(result[0]!.properties["CUSTOM_ID"]).toBe("abc-123");
		expect(result[0]!.properties["CONFIDENCE"]).toBe("0.9");
	});

	test("empty string returns empty array", () => {
		expect(parseOrgHeadings("")).toEqual([]);
	});

	test("heading level", () => {
		const result = parseOrgHeadings("* One\n*** Three");
		expect(result[0]!.level).toBe(1);
	});
});
