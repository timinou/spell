import { describe, expect, test } from "bun:test";
import { findCategory, findCategoryForId, resolveCategories } from "../src/categories";
import type { OrgConfig } from "../src/types";

const config: OrgConfig = {
	dirs: {
		tasks: {
			path: "!tasks",
			categories: {
				projects: { prefix: "PROJ", path: "projects" },
				bugs: { prefix: "BUG", path: "bugs" },
			},
		},
		research: {
			path: "!research",
			agent: "explore",
			categories: {
				spikes: { prefix: "SPIKE", path: "spikes" },
			},
		},
	},
	todoKeywords: ["ITEM", "DOING", "DONE"],
	requiredProperties: ["CUSTOM_ID", "EFFORT"],
};

describe("resolveCategories", () => {
	const root = "/fake/project";
	const categories = resolveCategories(config, root);

	test("returns all categories from all dirs", () => {
		expect(categories).toHaveLength(3);
	});

	test("resolves absolute paths correctly", () => {
		const proj = categories.find(c => c.name === "projects");
		expect(proj?.absPath).toBe("/fake/project/!tasks/projects");
		expect(proj?.dirAbsPath).toBe("/fake/project/!tasks");
	});

	test("inherits dir agent when category has none", () => {
		const spike = categories.find(c => c.name === "spikes");
		expect(spike?.agent).toBe("explore");
	});

	test("carries prefix from config", () => {
		const bugs = categories.find(c => c.name === "bugs");
		expect(bugs?.prefix).toBe("BUG");
	});
});

describe("findCategory", () => {
	const root = "/fake/project";
	const categories = resolveCategories(config, root);

	test("finds by logical name", () => {
		const cat = findCategory(categories, "projects");
		expect(cat?.prefix).toBe("PROJ");
	});

	test("finds by prefix (case-insensitive matching to uppercase)", () => {
		const cat = findCategory(categories, "BUG");
		expect(cat?.name).toBe("bugs");
	});

	test("returns undefined for unknown", () => {
		expect(findCategory(categories, "nonexistent")).toBeUndefined();
	});
});

describe("findCategoryForId", () => {
	const root = "/fake/project";
	const categories = resolveCategories(config, root);

	test("finds category from CUSTOM_ID", () => {
		const cat = findCategoryForId(categories, "PROJ-042-auth-refactor");
		expect(cat?.name).toBe("projects");
	});

	test("returns undefined for unknown prefix", () => {
		expect(findCategoryForId(categories, "FEAT-001-unknown")).toBeUndefined();
	});
});
