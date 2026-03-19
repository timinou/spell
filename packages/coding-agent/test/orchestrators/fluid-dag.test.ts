import { describe, expect, test } from "bun:test";

import { getReadyAgents, topologicalOrder, validatePlan } from "../../src/orchestrators/fluid/dag";
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
	describe("validatePlan", () => {
		test("accepts a valid simple chain", () => {
			const result = validatePlan(plan([node("A"), node("B", ["A"]), node("C", ["B"])]));
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		test("accepts a valid diamond graph", () => {
			const result = validatePlan(plan([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])]));
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		test("accepts valid parallel roots", () => {
			const result = validatePlan(plan([node("A"), node("B")]));
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		test("rejects an empty plan", () => {
			const result = validatePlan(plan([]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Plan must contain at least one agent");
		});

		test("rejects duplicate agent ids", () => {
			const result = validatePlan(plan([node("A"), node("A")]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Duplicate agent id: A");
		});

		test("rejects missing dependencies", () => {
			const result = validatePlan(plan([node("A"), node("B", ["A", "MISSING"])]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Agent B depends on missing agent MISSING");
		});

		test("rejects self dependency", () => {
			const result = validatePlan(plan([node("A", ["A"])]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Agent A cannot depend on itself");
		});

		test("rejects cyclic graphs", () => {
			const result = validatePlan(plan([node("A"), node("B", ["A", "C"]), node("C", ["B"])]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Plan contains dependency cycles");
		});

		test("rejects graph with no entry-point agents", () => {
			const result = validatePlan(plan([node("A", ["B"]), node("B", ["C"]), node("C", ["A"])]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Plan must contain at least one entry-point agent with no dependencies");
		});

		test("ignores canvasOutput metadata for DAG validity", () => {
			const result = validatePlan(
				plan([
					{ ...node("A"), canvasOutput: { type: "markdown", title: "Root" } },
					{ ...node("B", ["A"]), canvasOutput: { type: "table", title: "Child" } },
				]),
			);
			expect(result.valid).toBe(true);
		});

		test("rejects agents with empty task descriptions", () => {
			const result = validatePlan(plan([{ id: "A", task: "   ", dependsOn: [] }]));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Agent A must have a non-empty task description");
		});

		test("rejects invalid canvasOutput types", () => {
			const result = validatePlan(
				plan([
					{
						...node("A"),
						canvasOutput: { type: "timeline" as unknown as "markdown", title: "Invalid" },
					},
				]),
			);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Agent A has invalid canvasOutput type: timeline");
		});

		test("warns when plan has more than recommended agents", () => {
			const manyAgents = Array.from({ length: 13 }, (_, index) => node(`agent-${index + 1}`));
			const result = validatePlan(plan(manyAgents));
			expect(result.valid).toBe(true);
			expect(result.warnings).toContain("Plan has 13 agents; this exceeds the recommended limit of 12");
		});

		test("warns on duplicate canvasOutput titles within the same type", () => {
			const result = validatePlan(
				plan([
					{ ...node("A"), canvasOutput: { type: "markdown", title: "Summary" } },
					{ ...node("B"), canvasOutput: { type: "markdown", title: "summary" } },
				]),
			);
			expect(result.valid).toBe(true);
			expect(result.warnings).toContain('Duplicate canvasOutput title for type "markdown": "summary"');
		});

		test("accepts single-agent plan as a valid entry point", () => {
			const result = validatePlan(plan([node("A")]));
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
			const order = topologicalOrder(plan([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])]));

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
				"Cannot compute topological order for cyclic DAG",
			);
		});
	});

	describe("getReadyAgents", () => {
		test("returns root agents when nothing is completed", () => {
			const ready = getReadyAgents(
				plan([node("A"), node("B"), node("C", ["A"]), node("D", ["B", "C"])]),
				new Set<string>(),
			);
			expect(ready).toEqual(["A", "B"]);
		});

		test("includes agents whose dependencies are completed", () => {
			const ready = getReadyAgents(
				plan([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])]),
				new Set<string>(["A"]),
			);
			expect(ready).toEqual(["A", "B", "C"]);
		});

		test("requires all dependencies to be completed", () => {
			const ready = getReadyAgents(plan([node("A"), node("B"), node("C", ["A", "B"])]), new Set<string>(["A"]));
			expect(ready).toEqual(["A", "B"]);
			expect(ready).not.toContain("C");
		});
	});
});
