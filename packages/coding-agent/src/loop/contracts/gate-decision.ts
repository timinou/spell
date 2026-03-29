import { type Static, Type } from "@sinclair/typebox";
import { GateOutcomeSchema, GateTriggerSchema } from "./enums";

export const GateDecisionSchema = Type.Object(
	{
		gateId: Type.String({ minLength: 1 }),
		trigger: GateTriggerSchema,
		outcome: GateOutcomeSchema,
		reason: Type.String(),
		evidence: Type.Array(Type.String()),
		attemptNumber: Type.Integer({ minimum: 1 }),
		maxAttempts: Type.Integer({ minimum: 1 }),
		previousFindings: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

export type GateDecision = Static<typeof GateDecisionSchema>;
