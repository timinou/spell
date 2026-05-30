import { describe, expect, it } from "bun:test";
import { formatOrgResult, memoizeOrgResult } from "@spell/pi-coding-agent/tools/org";
import type { OrgItem } from "@spell/pi-org";

function createItem(overrides: Partial<OrgItem> = {}): OrgItem {
	return {
		id: overrides.id ?? "FEAT-001",
		title: overrides.title ?? "Add auth",
		state: overrides.state ?? "DOING",
		category: overrides.category ?? "features",
		dir: overrides.dir ?? "/org/features",
		file: overrides.file ?? "/org/features/FEAT-001.org",
		line: overrides.line ?? 12,
		level: overrides.level ?? 1,
		properties: overrides.properties ?? {},
		body: overrides.body,
		children: overrides.children,
	};
}

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

	it("formats query results as compact id/state/title lists", () => {
		const result = {
			items: [createItem(), createItem({ id: "FEAT-002", title: "Improve search", state: "ITEM" })],
			total: 3,
		};
		const output = formatOrgResult(result);
		expect(output).toBe(
			[
				"items: 2/3",
				"- FEAT-001 [DOING] Add auth",
				"- FEAT-002 [ITEM] Improve search",
				"[1 more items hidden. Narrow with category/state/query filters.]",
			].join("\n"),
		);
	});

	it("formats single item gets as compact summaries", () => {
		const result = {
			item: createItem({ body: "First detail line\nSecond detail line" }),
		};
		const output = formatOrgResult(result);
		expect(output).toContain("id: FEAT-001");
		expect(output).toContain("state: DOING");
		expect(output).toContain("title: Add auth");
		expect(output).toContain("body_length:");
		expect(output).toContain("preview: First detail line");
		expect(output).not.toContain("Second detail line");
	});

	it("formats fileContent responses as compact previews", () => {
		const content = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n");
		const output = formatOrgResult({ fileContent: content }, { command: "graph" });
		expect(output).toContain("line 1");
		expect(output).toContain("line 12");
		expect(output).not.toContain("line 13");
		expect(output).toContain("more lines hidden");
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

	it("formats mutation success with body length", () => {
		const result = { success: true, id: "FEAT-002-body-length", file: "/path/to/file.org", bodyLength: 0 };
		const output = formatOrgResult(result);
		expect(output).toContain("body_length: 0");
	});

	it("omits body length when missing from success result", () => {
		const result = { success: true, id: "FEAT-003-no-body-length", file: "/path/to/file.org" };
		const output = formatOrgResult(result);
		expect(output).not.toContain("body_length:");
	});

	it("formats validate-plan success with issue count", () => {
		const result = { valid: true, issues: [] };
		const output = formatOrgResult(result);
		expect(output).toBe("valid: true\nissues: 0");
	});

	it("formats validate-plan issues with categories and items", () => {
		const result = {
			valid: false,
			issues: [{ category: "thin-child-body", message: "Add details", items: ["FEAT-101"] }],
		};
		const output = formatOrgResult(result);
		expect(output).toContain("valid: false");
		expect(output).toContain("issues: 1");
		expect(output).toContain("thin-child-body: Add details");
		expect(output).toContain("- FEAT-101");
	});

	it("falls through to JSON for unknown shapes", () => {
		const result = { unexpected: "data" };
		const output = formatOrgResult(result);
		expect(output).toStartWith("{");
		expect(output).toContain("unexpected");
	});
});

describe("memoizeOrgResult", () => {
	it("suppresses repeated unchanged org outputs with compact guidance", () => {
		const cache = new Map<string, { fingerprint: string; text: string }>();
		const params = { command: "query", query: "todo:DOING", id: undefined, dir: undefined };
		const result = { items: [], total: 0 };
		const first = memoizeOrgResult(cache, params, result, "No items found.");
		const second = memoizeOrgResult(cache, params, result, "No items found.");
		expect(first).toBe("No items found.");
		expect(second).toContain("Repeat of previous org query result unchanged");
		expect(second).toContain("todo:DOING");
		expect(second).toContain("Continue using the prior IDs, states, and next-step guidance.");
	});
});
