import { describe, expect, test } from "bun:test";
import { extractIdLinks } from "../src/id-links";

describe("extractIdLinks", () => {
	test("returns empty list for empty body", () => {
		expect(extractIdLinks("")).toEqual([]);
	});

	test("extracts a single id link", () => {
		expect(extractIdLinks("See [[id:FEAT-001-add-auth]] for details.")).toEqual(["FEAT-001-add-auth"]);
	});

	test("extracts multiple id links in order", () => {
		expect(extractIdLinks("[[id:PROJ-001-platform]] then [[id:BUG-003-fix-timeout]]")).toEqual([
			"PROJ-001-platform",
			"BUG-003-fix-timeout",
		]);
	});

	test("ignores malformed links and non-id links", () => {
		const body = [
			"[[id:feat-001-lowercase]]",
			"[[id:FEAT-no-number]]",
			"[[id:FEAT-001-UppercaseSlug]]",
			"[[file:README.md]]",
		].join("\n");
		expect(extractIdLinks(body)).toEqual([]);
	});

	test("deduplicates duplicate links", () => {
		const body = "[[id:FEAT-001-add-auth]] [[id:FEAT-001-add-auth]] [[id:BUG-002-fix-refresh]]";
		expect(extractIdLinks(body)).toEqual(["FEAT-001-add-auth", "BUG-002-fix-refresh"]);
	});
});
