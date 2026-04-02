import { describe, expect, it } from "bun:test";
import { type GoalExecutionState, isValidTransition, transition } from "../../src/executor";

describe("execution state machine", () => {
	it("accepts documented valid transitions", () => {
		expect(isValidTransition("pending", "running")).toBe(true);
		expect(isValidTransition("running", "completed")).toBe(true);
		expect(isValidTransition("running", "failed")).toBe(true);
		expect(isValidTransition("failed", "retrying")).toBe(true);
		expect(isValidTransition("failed", "escalated")).toBe(true);
		expect(isValidTransition("retrying", "running")).toBe(true);
		expect(isValidTransition("retrying", "escalated")).toBe(true);
		expect(isValidTransition("escalated", "paused")).toBe(true);
	});

	it("throws on invalid transitions", () => {
		expect(() => transition("pending", "completed")).toThrow("Invalid state transition: pending -> completed");
		expect(() => transition("completed", "running")).toThrow("Invalid state transition: completed -> running");
		expect(() => transition("paused", "running")).toThrow("Invalid state transition: paused -> running");
	});

	it("remains serializable as strings", () => {
		const state: GoalExecutionState = "retrying";
		expect(JSON.stringify({ state })).toBe('{"state":"retrying"}');
	});
});
