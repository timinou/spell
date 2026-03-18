import { describe, expect, test } from "bun:test";

import { getReadyAgents, topologicalOrder, validateDag } from "../../src/orchestrators/fluid/dag";
import type { FluidAgentNode, FluidPlan } from "../../src/orchestrators/fluid/types";

function node(id: string, dependsOn: string[] = []): FluidAgentNode {
	return {
		id,
		task: `task-${id}`,
		dependsOn,
	};
}

function plan(agents: FluidAgentNode[]): FluidPlan {
	return { agents };
}

describe("fluid DAG utilities", () => {
	describe("validateDag", () => {
		test("accepts a valid simple chain", () => {
			const result = validateDag(plan([node("A"), node("B", ["A"]), node("C", ["B"])]));
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		test("accepts a valid diamond graph", () => {
			const result = validateDag(
				plan([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])])
			);
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		test("accepts valid parallel roots", () => {
			const result = validateDag(plan([node("A"), node("B") ]));
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		test("rejects an empty plan", () => {
			const result = validateDag(plan([]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Plan must contain at least one agent");
		});

		test("rejects duplicate agent ids", () => {
			const result = validateDag(plan([node("A"), node("A") ]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Duplicate agent id: A");
		});

		test("rejects missing dependencies", () => {
			const result = validateDag(plan([node("A"), node("B", ["A", "MISSING"]) ]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Agent B depends on missing agent MISSING");
		});

		test("rejects self dependency", () => {
			const result = validateDag(plan([node("A", ["A"])]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Agent A cannot depend on itself");
		});

		test("rejects cyclic graphs", () => {
			const result = validateDag(plan([node("A"), node("B", ["A", "C"]), node("C", ["B"])]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Plan contains dependency cycles");
		});

		test("rejects graph with no entry-point agents", () => {
			const result = validateDag(plan([node("A", ["B"]), node("B", ["C"]), node("C", ["A"])]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"Plan must contain at least one entry-point agent with no dependencies"
			);
		});

		test("ignores canvasOutput metadata for DAG validity", () => {
			const result = validateDag(
				plan([
					{ ...node("A"), canvasOutput: { type: "markdown", title: "Root" } },
					{ ...node("B", ["A"]), canvasOutput: { type: "table", title: "Child" } },
				])
			);
			expect(result.valid).toBe(true);
		});

		test("accepts single-agent plan as a valid entry point", () => {
			const result = validateDag(plan([node("A")]));
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});
	});

	describe("topologicalOrder", () => {
		test("returns linear chain order", () => {
			const order = topologicalOrder(plan([node("A"), node("B", ["A"]), node("C", ["B"])]));
			expect(order).toEqual(["A", "B", "C"]);
		});

		test("returns valid order for diamond graph", () => {
			const order = topologicalOrder(
				plan([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])])
			);

			expect(order).toHaveLength(4);
			expect(order[0]).toBe("A");
			expect(order[3]).toBe("D");
			expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
			expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
			expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
			expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
		});

		test("throws for cyclic graphs", () => {
			expect(() => topologicalOrder(plan([node("A", ["B"]), node("B", ["A"])]))).toThrow(
				"Cannot compute topological order for cyclic DAG"
			);
		});
	});

	describe("getReadyAgents", () => {
		test("returns root agents when nothing is completed", () => {
			const ready = getReadyAgents(
				plan([node("A"), node("B"), node("C", ["A"]), node("D", ["B", "C"])]),
				new Set<string>()
			);
			expect(ready).toEqual(["A", "B"]);
		});

		test("includes agents whose dependencies are completed", () => {
			const ready = getReadyAgents(
				plan([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])]),
				new Set<string>(["A"])
			);
			expect(ready).toEqual(["A", "B", "C"]);
		});

		test("requires all dependencies to be completed", () => {
			const ready = getReadyAgents(
				plan([node("A"), node("B"), node("C", ["A", "B"])]),
				new Set<string>(["A"])
			);
			expect(ready).toEqual(["A", "B"]);
			expect(ready).not.toContain("C");
		});
	});
});
