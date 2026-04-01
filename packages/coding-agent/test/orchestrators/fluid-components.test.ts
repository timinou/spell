import { describe, expect, test } from "bun:test";

import { splitIntoComponents } from "../../src/orchestrators/fluid/dag";
import type { FluidAgentNode, FluidPlan } from "../../src/orchestrators/fluid/types";

function node(id: string, dependsOn: string[] = [], extra: Partial<FluidAgentNode> = {}): FluidAgentNode {
	return { id, task: `Task ${id}`, dependsOn, ...extra };
}

function plan(...agents: FluidAgentNode[]): FluidPlan {
	return { agents };
}

describe("splitIntoComponents", () => {
	test("single connected chain A->B->C returns one component", () => {
		const p = plan(node("A"), node("B", ["A"]), node("C", ["B"]));
		const result = splitIntoComponents(p);
		expect(result).toHaveLength(1);
		expect(result[0].agents.map(a => a.id)).toEqual(["A", "B", "C"]);
	});

	test("two disconnected subgraphs returns 2 components", () => {
		const p = plan(node("A"), node("B", ["A"]), node("C"), node("D", ["C"]));
		const result = splitIntoComponents(p);
		expect(result).toHaveLength(2);
		const ids = result.map(c => c.agents.map(a => a.id).sort());
		expect(ids).toContainEqual(["A", "B"]);
		expect(ids).toContainEqual(["C", "D"]);
	});

	test("isolated nodes each become their own component", () => {
		const p = plan(node("A"), node("B"), node("C"));
		const result = splitIntoComponents(p);
		expect(result).toHaveLength(3);
		const ids = result.map(c => c.agents.map(a => a.id));
		expect(ids).toContainEqual(["A"]);
		expect(ids).toContainEqual(["B"]);
		expect(ids).toContainEqual(["C"]);
	});

	test("single node returns plan unchanged (length 1)", () => {
		const p = plan(node("A"));
		const result = splitIntoComponents(p);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(p);
	});

	test("empty plan returns plan unchanged", () => {
		const p = plan();
		const result = splitIntoComponents(p);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(p);
	});

	test("diamond dependency A->{B,C}->D is one component", () => {
		const p = plan(node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"]));
		const result = splitIntoComponents(p);
		expect(result).toHaveLength(1);
		expect(result[0].agents.map(a => a.id)).toEqual(["A", "B", "C", "D"]);
	});

	test("mixed graph {A->B}, {C}, {D->E->F} returns 3 components", () => {
		const p = plan(node("A"), node("B", ["A"]), node("C"), node("D"), node("E", ["D"]), node("F", ["E"]));
		const result = splitIntoComponents(p);
		expect(result).toHaveLength(3);
		const ids = result.map(c => c.agents.map(a => a.id).sort());
		expect(ids).toContainEqual(["A", "B"]);
		expect(ids).toContainEqual(["C"]);
		expect(ids).toContainEqual(["D", "E", "F"]);
	});

	test("agent ordering within each component is preserved", () => {
		// Agents declared in order; split should not reorder within a component
		const p = plan(node("C"), node("A"), node("B", ["A"]), node("D", ["C"]));
		const result = splitIntoComponents(p);
		// {C->D} and {A->B} — order within each should match original declaration order
		const compAB = result.find(c => c.agents.some(a => a.id === "A"))!;
		expect(compAB.agents.map(a => a.id)).toEqual(["A", "B"]);
		const compCD = result.find(c => c.agents.some(a => a.id === "C"))!;
		expect(compCD.agents.map(a => a.id)).toEqual(["C", "D"]);
	});
});
