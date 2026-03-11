import { describe, expect, test } from "bun:test";
import { parseId, titleToSlug } from "../src/id-generator";

describe("titleToSlug", () => {
	test("converts spaces to hyphens and lowercases", () => {
		expect(titleToSlug("Auth Refactor")).toBe("auth-refactor");
	});

	test("strips special characters", () => {
		expect(titleToSlug("Fix: null pointer (critical!)")).toBe("fix-null-pointer-critical");
	});

	test("collapses multiple spaces and hyphens", () => {
		expect(titleToSlug("a  b--c")).toBe("a-b-c");
	});

	test("caps length at 40 chars and strips trailing hyphens", () => {
		const long = "a".repeat(50);
		const result = titleToSlug(long);
		expect(result.length).toBeLessThanOrEqual(40);
	});

	test("empty string returns empty string", () => {
		expect(titleToSlug("")).toBe("");
	});

	test("all-special-chars returns empty string", () => {
		expect(titleToSlug("!@#$%^&*()")).toBe("");
	});
});

describe("parseId", () => {
	test("parses full ID with slug", () => {
		const result = parseId("PROJ-042-auth-refactor");
		expect(result).toEqual({ prefix: "PROJ", num: 42, slug: "auth-refactor" });
	});

	test("parses ID without slug", () => {
		const result = parseId("BUG-007");
		expect(result).toEqual({ prefix: "BUG", num: 7, slug: "" });
	});

	test("returns null for invalid format", () => {
		expect(parseId("not-an-id")).toBeNull();
		expect(parseId("")).toBeNull();
		expect(parseId("proj-001")).toBeNull(); // lowercase prefix
	});

	test("parses multi-part prefix", () => {
		const result = parseId("SPIKE-001-new-db");
		expect(result).toEqual({ prefix: "SPIKE", num: 1, slug: "new-db" });
	});
});
