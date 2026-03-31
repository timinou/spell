import { describe, expect, test } from "bun:test";
import type { ModeConfig, ModeConfigFrontmatter } from "../../src/capability/mode";
import { modeConfigCapability } from "../../src/capability/mode";
import type { SourceMeta } from "../../src/capability/types";
import { parseModeConfigSections, resolveModeConfig, resolveToolAccess } from "../../src/discovery/mode-helpers";

const testSource: SourceMeta = { provider: "test", providerName: "Test", path: "/test", level: "project" };

function makeMode(name: string, overrides?: Partial<ModeConfig>): ModeConfig {
	return {
		name,
		path: `/test/modes/${name}/MODE.md`,
		frontmatter: {},
		sections: { custom: {} },
		level: "project",
		_source: testSource,
		...overrides,
	};
}

describe("parseModeConfigSections", () => {
	test("parses known sections", () => {
		const body = `## Context
Context content here

## Instructions
Do this and that

## Focus Areas
Area one
Area two

## Examples
Example block`;

		const result = parseModeConfigSections(body);
		expect(result.context).toBe("Context content here");
		expect(result.instructions).toBe("Do this and that");
		expect(result.focusAreas).toBe("Area one\nArea two");
		expect(result.examples).toBe("Example block");
	});

	test("unknown headings preserved in custom map", () => {
		const body = `## Custom Section
Custom content

## Another Thing
More content`;

		const result = parseModeConfigSections(body);
		expect(result.custom["Custom Section"]).toBe("Custom content");
		expect(result.custom["Another Thing"]).toBe("More content");
	});

	test("phase sections stored correctly", () => {
		const body = `## Plan Phase
Planning steps

## Code Phase
Coding steps

## Review Phase
Review checklist`;

		const result = parseModeConfigSections(body);
		expect(result.planPhase).toBe("Planning steps");
		expect(result.codePhase).toBe("Coding steps");
		expect(result.reviewPhase).toBe("Review checklist");
	});

	test("empty body returns empty sections", () => {
		const result = parseModeConfigSections("");
		expect(result).toEqual({ custom: {} });
		expect(result.context).toBeUndefined();
		expect(result.instructions).toBeUndefined();
	});

	test("preamble before first heading is discarded", () => {
		const body = `This is preamble that should be ignored.

## Context
Actual content`;

		const result = parseModeConfigSections(body);
		expect(result.context).toBe("Actual content");
		// Preamble should not appear anywhere
		expect(result.custom).toEqual({});
	});

	test("case-insensitive heading matching", () => {
		const body = `## CONTEXT
Uppercase context

## FOCUS AREAS
Uppercase focus`;

		const result = parseModeConfigSections(body);
		expect(result.context).toBe("Uppercase context");
		expect(result.focusAreas).toBe("Uppercase focus");
	});
});

describe("extends chain resolution", () => {
	test("two-level extends merges frontmatter and sections", () => {
		const parent = makeMode("parent", {
			frontmatter: { description: "Parent desc", readOnly: true },
			sections: { custom: {}, context: "Parent context" },
		});
		const child = makeMode("child", {
			frontmatter: { extends: "parent", description: "Child desc" },
			sections: { custom: {}, instructions: "Child instructions" },
		});

		const allModes = new Map([
			["parent", parent],
			["child", child],
		]);
		const resolved = resolveModeConfig(child, allModes, new Map());

		// Child scalar overrides parent
		expect(resolved.frontmatter.description).toBe("Child desc");
		// Parent scalar inherited
		expect(resolved.frontmatter.readOnly).toBe(true);
		// Parent section preserved
		expect(resolved.sections.context).toBe("Parent context");
		// Child section preserved
		expect(resolved.sections.instructions).toBe("Child instructions");
		expect(resolved.extendsChain).toEqual(["parent", "child"]);
	});

	test("three-level extends merges in correct order", () => {
		const grandparent = makeMode("gp", {
			frontmatter: { description: "GP", readOnly: true },
			sections: { custom: {}, context: "GP context" },
		});
		const parent = makeMode("parent", {
			frontmatter: { extends: "gp", description: "Parent" },
			sections: { custom: {}, context: "Parent context" },
		});
		const child = makeMode("child", {
			frontmatter: { extends: "parent", model: "fast" },
			sections: { custom: {}, context: "Child context" },
		});

		const allModes = new Map([
			["gp", grandparent],
			["parent", parent],
			["child", child],
		]);
		const resolved = resolveModeConfig(child, allModes, new Map());

		// Most-derived scalar wins
		expect(resolved.frontmatter.description).toBe("Parent");
		expect(resolved.frontmatter.model).toBe("fast");
		expect(resolved.frontmatter.readOnly).toBe(true);
		// Sections concatenate along chain
		expect(resolved.sections.context).toBe("GP context\n\nParent context\n\nChild context");
		expect(resolved.extendsChain).toEqual(["gp", "parent", "child"]);
	});

	test("circular extends detected", () => {
		const a = makeMode("a", { frontmatter: { extends: "b" } });
		const b = makeMode("b", { frontmatter: { extends: "a" } });
		const allModes = new Map([
			["a", a],
			["b", b],
		]);

		expect(() => resolveModeConfig(a, allModes, new Map())).toThrow(/[Cc]ircular/);
	});

	test("self-extends detected", () => {
		const a = makeMode("a", { frontmatter: { extends: "a" } });
		const allModes = new Map([["a", a]]);

		expect(() => resolveModeConfig(a, allModes, new Map())).toThrow(/[Cc]ircular/);
	});

	test("missing extends target throws descriptive error", () => {
		const a = makeMode("a", { frontmatter: { extends: "nonexistent" } });
		const allModes = new Map([["a", a]]);

		expect(() => resolveModeConfig(a, allModes, new Map())).toThrow(/nonexistent.*not found/);
	});
});

describe("resolveToolAccess", () => {
	test("allow-only returns allowed tools", () => {
		const chain: ModeConfigFrontmatter[] = [{ tools: { allow: ["read", "grep", "find"] } }];
		expect(resolveToolAccess(chain)).toEqual(["read", "grep", "find"]);
	});

	test("parent allow + child deny removes denied tools", () => {
		const chain: ModeConfigFrontmatter[] = [
			{ tools: { allow: ["read", "write", "edit"] } },
			{ tools: { deny: ["write"] } },
		];
		expect(resolveToolAccess(chain)).toEqual(["read", "edit"]);
	});

	test("no tool restrictions returns undefined", () => {
		const chain: ModeConfigFrontmatter[] = [{}];
		expect(resolveToolAccess(chain)).toBeUndefined();
	});
});

describe("validation", () => {
	test("mutually exclusive allow and deny rejected", () => {
		const mode = makeMode("bad", {
			frontmatter: { tools: { allow: ["read"], deny: ["write"] } },
		});
		const error = modeConfigCapability.validate?.(mode);
		expect(error).toMatch(/mutually exclusive/);
	});
});
