import { type Static, Type } from "@sinclair/typebox";
import { LoopRoleSchema } from "./enums";
import { GateDecisionSchema } from "./gate-decision";

export const HandoffArtifactSchema = Type.Object(
	{
		fromRole: LoopRoleSchema,
		toRole: LoopRoleSchema,
		iteration: Type.Integer({ minimum: 0 }),
		changedFiles: Type.Array(Type.String()),
		gateResults: Type.Array(GateDecisionSchema),
		openFindings: Type.Array(Type.String()),
		summary: Type.String(),
	},
	{ additionalProperties: false },
);

export type HandoffArtifact = Static<typeof HandoffArtifactSchema>;
