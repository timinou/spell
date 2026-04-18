import { describe, expect, it } from "bun:test";
import {
	buildDependencyGraph,
	parseOrgDependProperties,
	parseTriggerExpression,
	topologicalSort,
} from "../../src/loop/ingestion/org-depend";

const ORG_CONTENT = `
* ITEM Implement auth API
:PROPERTIES:
:CUSTOM_ID: FEAT-001
:DEPENDS: FEAT-000
:TRIGGER: FEAT-002(DOING)
:GATE_CMD: bun test
:END:

** Acceptance Criteria
- [ ] JWT tokens work
- [ ] Refresh supported

* DOING Setup project
:PROPERTIES:
:CUSTOM_ID: FEAT-000
:END:
`;

describe("parseTriggerExpression", () => {
	it("parses valid ID(KEYWORD) format", () => {
		const result = parseTriggerExpression("FEAT-001(DOING)");
		expect(result).toEqual({ targetId: "FEAT-001", keyword: "DOING" });
	});

	it("returns undefined for malformed input", () => {
		expect(parseTriggerExpression("FEAT-001")).toBeUndefined();
		expect(parseTriggerExpression("")).toBeUndefined();
		expect(parseTriggerExpression("()")).toBeUndefined();
		expect(parseTriggerExpression("FEAT-001()")).toBeUndefined();
	});

	it("trims whitespace before parsing", () => {
		const result = parseTriggerExpression("  FEAT-001(DOING)  ");
		expect(result).toEqual({ targetId: "FEAT-001", keyword: "DOING" });
	});
});

describe("parseOrgDependProperties", () => {
	it("extracts properties from multi-heading org content", () => {
		const props = parseOrgDependProperties(ORG_CONTENT);
		expect(props.length).toBe(2);

		const feat001 = props.find(p => p.customId === "FEAT-001")!;
		expect(feat001.title).toBe("Implement auth API");
		expect(feat001.state).toBe("ITEM");
		expect(feat001.blockers).toEqual(["FEAT-000"]);
		expect(feat001.triggers).toEqual([{ targetId: "FEAT-002", keyword: "DOING" }]);
		expect(feat001.gateCmd).toBe("bun test");
	});

	it("handles headings with no properties drawer", () => {
		const content = `
* TODO Some heading without properties
Some body text.
`;
		const props = parseOrgDependProperties(content);
		expect(props).toEqual([]);
	});

	it("parses heading with minimal properties", () => {
		const props = parseOrgDependProperties(ORG_CONTENT);
		const feat000 = props.find(p => p.customId === "FEAT-000")!;
		expect(feat000.title).toBe("Setup project");
		expect(feat000.state).toBe("DOING");
		expect(feat000.blockers).toEqual([]);
		expect(feat000.triggers).toEqual([]);
	});

	it("parses space-separated multi-dependency DEPENDS property", () => {
		const content = `
* ITEM Build API
:PROPERTIES:
:CUSTOM_ID: FEAT-010
:DEPENDS: FEAT-001 FEAT-002 FEAT-003
:END:
`;
		const props = parseOrgDependProperties(content);
		expect(props.length).toBe(1);
		expect(props[0].blockers).toEqual(["FEAT-001", "FEAT-002", "FEAT-003"]);
	});

	it("falls back to legacy BLOCKER property", () => {
		const content = `
* ITEM Legacy Item
:PROPERTIES:
:CUSTOM_ID: FEAT-020
:BLOCKER: FEAT-001 FEAT-002
:END:
`;
		const props = parseOrgDependProperties(content);
		expect(props.length).toBe(1);
		expect(props[0].blockers).toEqual(["FEAT-001", "FEAT-002"]);
	});
});

describe("buildDependencyGraph", () => {
	it("detects circular dependencies", () => {
		const props = [makeProp("A", ["B"]), makeProp("B", ["C"]), makeProp("C", ["A"])];
		const graph = buildDependencyGraph(props);
		expect(graph.cycles.length).toBeGreaterThan(0);
		// The cycle should contain all three nodes
		const cycleNodes = new Set(graph.cycles.flat());
		expect(cycleNodes.has("A")).toBe(true);
		expect(cycleNodes.has("B")).toBe(true);
		expect(cycleNodes.has("C")).toBe(true);
	});

	it("reports no cycles for a linear chain", () => {
		const props = [makeProp("A", ["B"]), makeProp("B", ["C"]), makeProp("C", [])];
		const graph = buildDependencyGraph(props);
		expect(graph.cycles).toEqual([]);
	});

	it("builds correct edges from blockers", () => {
		const props = [makeProp("A", ["B", "C"]), makeProp("B", []), makeProp("C", [])];
		const graph = buildDependencyGraph(props);
		expect(graph.edges).toContainEqual({ from: "B", to: "A" });
		expect(graph.edges).toContainEqual({ from: "C", to: "A" });
	});
});

describe("topologicalSort", () => {
	it("returns valid order for a linear chain", () => {
		const props = [makeProp("A", ["B"]), makeProp("B", ["C"]), makeProp("C", [])];
		const graph = buildDependencyGraph(props);
		const order = topologicalSort(graph);
		expect(order.indexOf("C")).toBeLessThan(order.indexOf("B"));
		expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
	});

	it("throws on cyclic graph", () => {
		const props = [makeProp("A", ["B"]), makeProp("B", ["A"])];
		const graph = buildDependencyGraph(props);
		expect(() => topologicalSort(graph)).toThrow();
	});
});

// Helper: minimal OrgDependProperties with customId and blockers
function makeProp(id: string, blockers: string[]) {
	return {
		customId: id,
		title: id,
		state: "ITEM",
		blockers,
		triggers: [],
	} as ReturnType<typeof parseOrgDependProperties>[number];
}
