import { describe, expect, test } from "bun:test";
import { extractOrgKeywords, orgToMarkdown, orgToPlainText, parseOrgHeadings } from "../src/org-parse";

describe("orgToMarkdown", () => {
	test("converts headings", () => {
		const result = orgToMarkdown("* H1\n** H2");
		expect(result).toContain("H1");
		expect(result).toContain("H2");
	});

	test("converts src blocks", () => {
		const org = "#+begin_src typescript\nconst x = 1;\n#+end_src";
		const result = orgToMarkdown(org);
		expect(result).toContain("const x = 1;");
		expect(result).toContain("```");
	});

	test("handles empty string", () => {
		expect(orgToMarkdown("").trim()).toBe("");
	});

	test("PROPERTIES drawer does not produce garbage", () => {
		const org = "* My Heading\n:PROPERTIES:\n:CUSTOM_ID: test-123\n:END:\nBody text here";
		const result = orgToMarkdown(org);
		expect(result).toContain("Body text here");
		expect(typeof result).toBe("string");
	});
});

describe("orgToPlainText", () => {
	test("strips markup", () => {
		const result = orgToPlainText("* Heading\nSome text");
		expect(result).toContain("Heading");
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	test("handles empty string", () => {
		expect(orgToPlainText("").trim()).toBe("");
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
		expect(result[0]!.children).toHaveLength(1);
		expect(result[0]!.children[0]!.title).toBe("H2");
	});

	test("empty string returns empty array", () => {
		expect(parseOrgHeadings("")).toEqual([]);
	});

	test("heading level", () => {
		const result = parseOrgHeadings("* One\n*** Three");
		expect(result[0]!.level).toBe(1);
	});
});
