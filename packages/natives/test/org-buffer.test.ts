import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import * as path from "node:path";

// Load native addon directly, bypassing the embedded-addon import chain
// which requires file assets that may not exist in development.
const require_ = createRequire(import.meta.url);
const nativesDir = path.join(import.meta.dir, "..", "native");
const native = require_(path.join(nativesDir, "pi_natives.dev.node")) as {
	executeOrg(options: Record<string, unknown>): { output: unknown; error: boolean };
};

function executeOrg(options: Record<string, unknown>): { output: unknown; error: boolean } {
	return native.executeOrg(options);
}

describe("executeOrg NAPI bridge", () => {
	it("parses org source into items", () => {
		const result = executeOrg({
			command: "parse",
			source: `* DOING My Task
:PROPERTIES:
:CUSTOM_ID: T-001
:END:

Body text.
`,
			todoKeywords: ["DOING", "DONE"],
			category: "test",
			dir: "tasks",
			file: "/test.org",
		});
		expect(result.error).toBe(false);
		const output = result.output as { items: Array<{ id: string; title: string; state: string; level: number }> };
		expect(output.items).toHaveLength(1);
		expect(output.items[0].id).toBe("T-001");
		expect(output.items[0].title).toBe("My Task");
		expect(output.items[0].state).toBe("DOING");
		expect(output.items[0].level).toBe(1);
	});

	it("parses items with body when includeBody is true", () => {
		const result = executeOrg({
			command: "parse",
			source: `* DOING Task
:PROPERTIES:
:CUSTOM_ID: T-002
:END:

Body content here.
`,
			todoKeywords: ["DOING", "DONE"],
			includeBody: true,
		});
		expect(result.error).toBe(false);
		const output = result.output as { items: Array<{ body?: string }> };
		expect(output.items[0].body).toContain("Body content here.");
	});

	it("filters items by todo state", () => {
		const source = `* DOING Task A
:PROPERTIES:
:CUSTOM_ID: T-A
:END:

* DONE Task B
:PROPERTIES:
:CUSTOM_ID: T-B
:END:

* DOING Task C
:PROPERTIES:
:CUSTOM_ID: T-C
:END:
`;
		const result = executeOrg({
			command: "query",
			source,
			todoKeywords: ["DOING", "DONE"],
			query: "todo:DOING",
		});
		expect(result.error).toBe(false);
		const output = result.output as { items: unknown[]; total: number };
		expect(output.total).toBe(2);
	});

	it("computes dependency graph from items", () => {
		const source = `* ITEM Task A
:PROPERTIES:
:CUSTOM_ID: T-A
:END:

* ITEM Task B
:PROPERTIES:
:CUSTOM_ID: T-B
:BLOCKERS: T-A
:END:
`;
		const result = executeOrg({
			command: "graph",
			source,
			todoKeywords: ["ITEM", "DONE"],
		});
		expect(result.error).toBe(false);
		const output = result.output as { nodes: unknown[]; edges: unknown[]; cycles: unknown[] };
		expect(output.nodes.length).toBeGreaterThanOrEqual(2);
		expect(output.edges.length).toBeGreaterThanOrEqual(1);
		expect(output.cycles).toHaveLength(0);
	});

	it("computes wave layers for items", () => {
		const source = `* ITEM Task A
:PROPERTIES:
:CUSTOM_ID: T-A
:END:

* ITEM Task B
:PROPERTIES:
:CUSTOM_ID: T-B
:BLOCKERS: T-A
:END:

* ITEM Task C
:PROPERTIES:
:CUSTOM_ID: T-C
:BLOCKERS: T-B
:END:
`;
		const result = executeOrg({
			command: "computeWaves",
			source,
			todoKeywords: ["ITEM", "DONE"],
		});
		expect(result.error).toBe(false);
		const output = result.output as { waves: Array<{ wave: number; items: Array<{ id: string }> }> };
		expect(output.waves.length).toBeGreaterThanOrEqual(2);
	});

	it("deserializes TS-shaped items without byte_range (BUG-218 regression)", () => {
		// Items shaped like TS would construct them: no byte_range, clocks, or children fields.
		// Before BUG-218 fix, these would silently fail to deserialize, producing empty results.
		const result = executeOrg({
			command: "computeWaves",
			items: [
				{
					id: "T-A",
					title: "Task A",
					state: "ITEM",
					category: "test",
					dir: "tasks",
					file: "/test.org",
					line: 1,
					level: 1,
					properties: {},
				},
				{
					id: "T-B",
					title: "Task B",
					state: "ITEM",
					category: "test",
					dir: "tasks",
					file: "/test.org",
					line: 5,
					level: 1,
					properties: { BLOCKERS: "T-A" },
				},
			],
		});
		expect(result.error).toBe(false);
		const output = result.output as { waves: Array<{ wave: number; items: Array<{ id: string }> }> };
		expect(output.waves.length).toBeGreaterThanOrEqual(2);
	});

	it("computes next actionable wave", () => {
		const source = `* DONE Task A
:PROPERTIES:
:CUSTOM_ID: T-A
:END:

* ITEM Task B
:PROPERTIES:
:CUSTOM_ID: T-B
:BLOCKERS: T-A
:END:
`;
		const result = executeOrg({
			command: "nextWave",
			source,
			todoKeywords: ["ITEM", "DONE"],
			doneStates: ["DONE"],
		});
		expect(result.error).toBe(false);
		const output = result.output as { items: Array<Record<string, unknown>> };
		expect(output.items.length).toBeGreaterThanOrEqual(1);
	});

	it("finds connected components", () => {
		const source = `* ITEM Task A
:PROPERTIES:
:CUSTOM_ID: T-A
:END:

* ITEM Task B
:PROPERTIES:
:CUSTOM_ID: T-B
:BLOCKERS: T-A
:END:

* ITEM Task C
:PROPERTIES:
:CUSTOM_ID: T-C
:END:
`;
		const result = executeOrg({
			command: "connectedComponents",
			source,
			todoKeywords: ["ITEM", "DONE"],
		});
		expect(result.error).toBe(false);
		const output = result.output as { components: unknown[] };
		// A-B form one component, C is isolated
		expect(output.components.length).toBeGreaterThanOrEqual(2);
	});

	it("replaces section content", () => {
		const source = `* DOING Task
:PROPERTIES:
:CUSTOM_ID: T-001
:END:

** Context
Old content.

** Implementation
Code here.
`;
		const result = executeOrg({
			command: "editSection",
			source,
			section: "Context",
			body: "New content.",
			mode: "replace",
			itemStart: 0,
			itemEnd: source.length,
		});
		expect(result.error).toBe(false);
		const output = result.output as { source: string };
		expect(output.source).toContain("New content.");
		expect(output.source).not.toContain("Old content.");
		expect(output.source).toContain("** Implementation");
	});

	it("appends to section content", () => {
		const source = `* DOING Task
:PROPERTIES:
:CUSTOM_ID: T-001
:END:

** Context
Existing.

** Implementation
Code.
`;
		const result = executeOrg({
			command: "editSection",
			source,
			section: "Context",
			body: "Appended.",
			mode: "append",
			itemStart: 0,
			itemEnd: source.length,
		});
		expect(result.error).toBe(false);
		const output = result.output as { source: string };
		expect(output.source).toContain("Existing.");
		expect(output.source).toContain("Appended.");
	});

	it("converts org to markdown", () => {
		const result = executeOrg({
			command: "toMarkdown",
			source: "* Heading\n\n#+begin_src rust\nfn main() {}\n#+end_src\n",
		});
		expect(result.error).toBe(false);
		const output = result.output as { markdown: string };
		expect(output.markdown).toContain("# Heading");
		expect(output.markdown).toContain("```rust");
	});

	it("converts org to plain text", () => {
		const result = executeOrg({
			command: "toPlainText",
			source: "* Heading\nBody text.\n",
		});
		expect(result.error).toBe(false);
		const output = result.output as { text: string };
		expect(output.text).toContain("Heading");
		expect(output.text).toContain("Body text.");
	});

	it("returns error for unknown command", () => {
		const result = executeOrg({ command: "bogus" });
		expect(result.error).toBe(true);
	});

	it("returns error when source is missing for parse", () => {
		expect(() => executeOrg({ command: "parse" })).toThrow();
	});
});
