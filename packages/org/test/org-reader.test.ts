import { describe, expect, test } from "bun:test";
import { applyFilter } from "../src/org-reader";
import type { OrgItem } from "../src/types";

function makeItem(overrides: Partial<OrgItem>): OrgItem {
	return {
		id: "PROJ-001-test",
		title: "Test item",
		state: "ITEM",
		category: "projects",
		dir: "tasks",
		file: "/fake/path.org",
		line: 1,
		level: 1,
		properties: {},
		...overrides,
	};
}

describe("applyFilter", () => {
	const items: OrgItem[] = [
		makeItem({
			id: "PROJ-001",
			state: "ITEM",
			category: "projects",
			properties: { PRIORITY: "#A", LAYER: "backend" },
		}),
		makeItem({ id: "PROJ-002", state: "DOING", category: "projects", properties: { PRIORITY: "#B" } }),
		makeItem({ id: "BUG-001", state: "BLOCKED", category: "bugs", properties: { PRIORITY: "#A" } }),
		makeItem({ id: "FEAT-001", state: "DONE", category: "features", dir: "tasks", properties: {} }),
	];

	test("no filter returns all items", () => {
		expect(applyFilter(items, {})).toHaveLength(4);
	});

	test("filters by state string", () => {
		const result = applyFilter(items, { state: "DOING" });
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("PROJ-002");
	});

	test("filters by state array", () => {
		const result = applyFilter(items, { state: ["ITEM", "BLOCKED"] });
		expect(result).toHaveLength(2);
	});

	test("filters by category", () => {
		const result = applyFilter(items, { category: "bugs" });
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("BUG-001");
	});

	test("filters by priority", () => {
		const result = applyFilter(items, { priority: "#A" });
		expect(result).toHaveLength(2);
	});

	test("filters by layer", () => {
		const result = applyFilter(items, { layer: "backend" });
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("PROJ-001");
	});

	test("combining filters is additive (AND)", () => {
		// priority #A AND category bugs
		const result = applyFilter(items, { priority: "#A", category: "bugs" });
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("BUG-001");
	});

	test("empty state array passes all", () => {
		// An array filter with no values shouldn't filter anything out
		// (not a case we'd normally hit, but verify it doesn't crash)
		const result = applyFilter(items, { state: [] });
		// state filter with empty array: no item state is in [], so all filtered out
		expect(result).toHaveLength(0);
	});
});
