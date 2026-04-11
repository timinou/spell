import { describe, expect, test } from "bun:test";
import { MutableDag } from "../../src/task/mutable-dag";

interface TestNode {
	label: string;
	filesDeps?: string[];
}

function node(label: string, filesDeps?: string[]): TestNode {
	return { label, filesDeps };
}

describe("MutableDag", () => {
	test("adds nodes and computes deterministic topological order", () => {
		const dag = new MutableDag<TestNode>();
		dag.addNode("A", node("A"));
		dag.addNode("B", node("B"), ["A"]);
		dag.addNode("C", node("C"), ["A"]);
		dag.addNode("D", node("D"), ["B", "C"]);

		expect(dag.topologicalOrder()).toEqual(["A", "B", "C", "D"]);
		expect(dag.getReadyNodeIds()).toEqual(["A"]);
		expect(dag.getReadyNodeIds(new Set(["A"]))).toEqual(["B", "C"]);
	});

	test("rejects duplicate nodes, missing dependencies, self dependencies, and cycles without mutating state", () => {
		const dag = new MutableDag<TestNode>([["A", node("A")]]);
		const snapshot = dag.topologicalOrder();

		expect(() => dag.addNode("A", node("dup"))).toThrow("MutableDag duplicate node: A");
		expect(() => dag.addNode("B", node("B"), ["missing"])).toThrow("MutableDag missing dependency: missing");
		expect(() => dag.addNode("C", node("C"), ["C"])).toThrow("MutableDag self-dependency rejected: C");
		dag.addNode("B", node("B"), ["A"]);
		expect(() => dag.addEdge("B", "A")).toThrow("MutableDag contains dependency cycles");
		expect(dag.topologicalOrder()).toEqual(["A", "B"]);
		expect(snapshot).toEqual(["A"]);
	});

	test("updates edges and dependencies transactionally", () => {
		const dag = new MutableDag<TestNode>([
			["A", node("A")],
			["B", node("B"), ["A"]],
			["C", node("C")],
		]);

		expect(() => dag.setDependencies("C", ["B", "C"])).toThrow("MutableDag self-dependency rejected: C");
		expect(dag.getDependencies("C")).toEqual([]);
		dag.setDependencies("C", ["A"]);
		expect(dag.getDependencies("C")).toEqual(["A"]);
		dag.removeEdge("A", "C");
		expect(dag.getDependencies("C")).toEqual([]);
	});

	test("removes nodes in cascade or orphan mode", () => {
		const cascade = new MutableDag<TestNode>([
			["A", node("A")],
			["B", node("B"), ["A"]],
			["C", node("C"), ["B"]],
			["D", node("D"), ["A"]],
		]);
		cascade.removeNode("A", "cascade");
		expect(cascade.topologicalOrder()).toEqual([]);

		const orphan = new MutableDag<TestNode>([
			["A", node("A")],
			["B", node("B"), ["A"]],
			["C", node("C"), ["B"]],
			["D", node("D"), ["A"]],
		]);
		orphan.removeNode("A", "orphan");
		expect(orphan.topologicalOrder()).toEqual(["B", "D", "C"]);
		expect(orphan.getDependencies("B")).toEqual([]);
		expect(orphan.getDependencies("D")).toEqual([]);
		expect(orphan.getDependencies("C")).toEqual(["B"]);
	});

	test("splits disconnected components in declaration order", () => {
		const dag = new MutableDag<TestNode>([
			["C", node("C")],
			["A", node("A")],
			["B", node("B"), ["A"]],
			["D", node("D"), ["C"]],
		]);

		const components = dag.splitIntoComponents();
		expect(components).toHaveLength(2);
		expect(components[0].topologicalOrder()).toEqual(["C", "D"]);
		expect(components[1].topologicalOrder()).toEqual(["A", "B"]);
	});

	test("detects file overlap helpers using filesDeps", () => {
		const dag = new MutableDag<TestNode>([
			["A", node("A", ["one.ts", "two.ts"])],
			["B", node("B", ["two.ts"]), ["A"]],
			["C", node("C", ["three.ts"])],
		]);

		expect(dag.hasFileOverlap("A", "B")).toBe(true);
		expect(dag.hasFileOverlap("A", "C")).toBe(false);
		expect(dag.getOverlappingNodeIds("A")).toEqual(["B"]);
	});
});
