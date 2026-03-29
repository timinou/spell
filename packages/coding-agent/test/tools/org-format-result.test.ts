import { describe, expect, it } from "bun:test";
import { formatOrgResult } from "@oh-my-pi/pi-coding-agent/tools/org";

describe("formatOrgResult", () => {
	it("formats mutation success as plain text", () => {
		const result = { success: true, id: "FEAT-001-add-auth", updated: ["body"], file: "/path/to/file.org" };
		const output = formatOrgResult(result);
		expect(output).not.toStartWith("{");
		expect(output).toContain("id: FEAT-001-add-auth");
		expect(output).toContain("updated: body");
		expect(output).toContain("file: /path/to/file.org");
	});

	it("formats create result with category and state", () => {
		const result = {
			success: true,
			id: "PLAN-001-auth",
			file: "/org/plans/PLAN-001.org",
			category: "plans",
			state: "INIT",
		};
		const output = formatOrgResult(result);
		expect(output).toContain("id: PLAN-001-auth");
		expect(output).toContain("state: INIT");
		expect(output).toContain("category: plans");
	});

	it("formats error result as plain text", () => {
		const result = { error: true, message: "Item not found", code: "NOT_FOUND" };
		const output = formatOrgResult(result);
		expect(output).toContain("error: Item not found");
		expect(output).toContain("(NOT_FOUND)");
		expect(output).not.toStartWith("{");
	});

	it("formats error without code", () => {
		const result = { error: true, message: "Something went wrong" };
		const output = formatOrgResult(result);
		expect(output).toBe("error: Something went wrong");
	});

	it("falls through to JSON for unknown shapes", () => {
		const result = { unexpected: "data" };
		const output = formatOrgResult(result);
		expect(output).toStartWith("{");
		expect(output).toContain("unexpected");
	});
});
