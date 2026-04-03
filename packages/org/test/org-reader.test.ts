import { describe, expect, test } from "bun:test";
import { applyFilter, sortItems } from "../src/org-reader";
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

	test("filters by level", () => {
		const items: OrgItem[] = [
			makeItem({ id: "PROJ-001", level: 0 }),
			makeItem({ id: "PROJ-002", level: 1 }),
			makeItem({ id: "PROJ-003", level: 2 }),
			makeItem({ id: "PROJ-004", level: 0 }),
		];
		const result = applyFilter(items, { level: 0 });
		expect(result).toHaveLength(2);
		expect(result.map(item => item.id)).toEqual(["PROJ-001", "PROJ-004"]);
	});

	test("empty state array passes all", () => {
		// An array filter with no values shouldn't filter anything out
		// (not a case we'd normally hit, but verify it doesn't crash)
		const result = applyFilter(items, { state: [] });
		// state filter with empty array: no item state is in [], so all filtered out
		expect(result).toHaveLength(0);
	});
});

describe("sortItems", () => {
	const items: OrgItem[] = [
		makeItem({ id: "FEAT-001", state: "DONE", properties: {} }),
		makeItem({ id: "PROJ-003", state: "DOING", properties: { PRIORITY: "#B" } }),
		makeItem({ id: "BUG-002", state: "ITEM", properties: { PRIORITY: "#A" } }),
		makeItem({ id: "PROJ-001", state: "DOING", properties: { PRIORITY: "#A" } }),
	];

	test("default sort: priority > state > id", () => {
		const sorted = sortItems([...items]);
		expect(sorted.map(i => i.id)).toEqual([
			"PROJ-001", // #A, DOING
			"BUG-002", // #A, ITEM
			"PROJ-003", // #B, DOING
			"FEAT-001", // no priority (last)
		]);
	});

	test("sort by state only", () => {
		const sorted = sortItems([...items], "state");
		// DOING < ITEM < DONE in state order
		expect(sorted.map(i => i.state)).toEqual(["DOING", "DOING", "ITEM", "DONE"]);
	});

	test("sort by id only", () => {
		const sorted = sortItems([...items], "id");
		expect(sorted.map(i => i.id)).toEqual(["BUG-002", "FEAT-001", "PROJ-001", "PROJ-003"]);
	});

	test("multi-key sort: state then priority", () => {
		const sorted = sortItems([...items], "state priority");
		expect(sorted.map(i => i.id)).toEqual([
			"PROJ-001", // DOING, #A
			"PROJ-003", // DOING, #B
			"BUG-002", // ITEM, #A
			"FEAT-001", // DONE, no priority
		]);
	});

	test("unknown sort key is a no-op (stable)", () => {
		const input = [...items];
		const sorted = sortItems(input, "nonexistent");
		expect(sorted.map(i => i.id)).toEqual(items.map(i => i.id));
	});
});
