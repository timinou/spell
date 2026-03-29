import { describe, expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
	ChildCompletionSignalSchema,
	FAILURE_POLICIES,
	GATE_TRIGGERS,
	GATE_TYPES,
	GateDecisionSchema,
	HandoffArtifactSchema,
	IterationCheckpointSchema,
	LOOP_STATES,
	LoopEventSchema,
} from "../../src/loop/contracts";

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);

async function readJson(name: string): Promise<unknown> {
	return Bun.file(new URL(name, FIXTURE_DIR)).json();
}

describe("loop contracts", () => {
	it("validates the shipped valid fixtures", async () => {
		expect(Value.Check(LoopEventSchema, await readJson("valid-loop-event.json"))).toBe(true);
		expect(Value.Check(GateDecisionSchema, await readJson("valid-gate-decision.json"))).toBe(true);
		expect(Value.Check(ChildCompletionSignalSchema, await readJson("valid-child-completion.json"))).toBe(true);
		expect(Value.Check(HandoffArtifactSchema, await readJson("valid-handoff-artifact.json"))).toBe(true);
		expect(Value.Check(IterationCheckpointSchema, await readJson("valid-iteration-checkpoint.json"))).toBe(true);
	});

	it("rejects invalid fixtures with missing or extra fields", async () => {
		expect(Value.Check(LoopEventSchema, await readJson("invalid-loop-event.json"))).toBe(false);
		expect(Value.Check(GateDecisionSchema, await readJson("invalid-gate-decision.json"))).toBe(false);
		expect(Value.Check(ChildCompletionSignalSchema, await readJson("invalid-child-completion.json"))).toBe(false);
		expect(Value.Check(HandoffArtifactSchema, await readJson("invalid-handoff-artifact.json"))).toBe(false);
		expect(Value.Check(IterationCheckpointSchema, await readJson("invalid-iteration-checkpoint.json"))).toBe(false);
	});

	it("round-trips the valid fixtures through JSON serialization", async () => {
		for (const [schema, name] of [
			[LoopEventSchema, "valid-loop-event.json"],
			[GateDecisionSchema, "valid-gate-decision.json"],
			[ChildCompletionSignalSchema, "valid-child-completion.json"],
			[HandoffArtifactSchema, "valid-handoff-artifact.json"],
			[IterationCheckpointSchema, "valid-iteration-checkpoint.json"],
		] as const) {
			const fixture = await readJson(name);
			const roundTripped = JSON.parse(JSON.stringify(fixture));
			expect(Value.Check(schema, roundTripped)).toBe(true);
		}
	});

	it("keeps all contract enums as string unions", () => {
		expect(Object.values(LOOP_STATES)).toEqual(expect.arrayContaining(["planning", "iterating", "validating"]));
		expect(Object.values(GATE_TRIGGERS)).toEqual(
			expect.arrayContaining(["every-iteration", "every-n", "on-reflection", "on-completion", "on-child-complete"]),
		);
		expect(Object.values(FAILURE_POLICIES)).toEqual(expect.arrayContaining(["retry", "block", "skip", "escalate"]));
		expect(Object.values(GATE_TYPES)).toEqual(expect.arrayContaining(["command", "llm-review", "artifact", "human"]));
	});

	it("requires version on loop event envelopes", () => {
		expect(Value.Check(LoopEventSchema, { type: "loop.created", loopId: "LOOP-1", timestamp: 1, payload: {} })).toBe(
			false,
		);
	});
});
