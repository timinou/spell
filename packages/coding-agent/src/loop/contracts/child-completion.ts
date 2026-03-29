import { type Static, Type } from "@sinclair/typebox";
import { ChildOutcomeSchema } from "./enums";
import { GateDecisionSchema } from "./gate-decision";

export const ChildCompletionSignalSchema = Type.Object(
	{
		childLoopId: Type.String({ minLength: 1 }),
		parentLoopId: Type.String({ minLength: 1 }),
		outcome: ChildOutcomeSchema,
		summary: Type.String(),
		artifacts: Type.Array(Type.String()),
		gateResults: Type.Array(GateDecisionSchema),
	},
	{ additionalProperties: false },
);

export type ChildCompletionSignal = Static<typeof ChildCompletionSignalSchema>;
